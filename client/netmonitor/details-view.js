/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-disable mozilla/reject-some-requires */
/* globals window, dumpn, $, gNetwork */

"use strict";

const promise = require("promise");
const EventEmitter = require("devtools/shared/event-emitter");
const { Heritage } = require("devtools/client/shared/widgets/view-helpers");
const { Task } = require("devtools/shared/task");
const { ToolSidebar } = require("devtools/client/framework/sidebar");
const { VariablesView } = require("resource://devtools/client/shared/widgets/VariablesView.jsm");
const { EVENTS } = require("./events");
const { L10N } = require("./l10n");
const { Filters } = require("./filter-predicates");
const {
  decodeUnicodeUrl,
} = require("./request-utils");
const { createFactory } = require("devtools/client/shared/vendor/react");
const ReactDOM = require("devtools/client/shared/vendor/react-dom");
const Provider = createFactory(require("devtools/client/shared/vendor/react-redux").Provider);
const ParamsPanel = createFactory(require("./shared/components/params-panel"));
const PreviewPanel = createFactory(require("./shared/components/preview-panel"));
const ResponsePanel = createFactory(require("./shared/components/response-panel"));
const SecurityPanel = createFactory(require("./shared/components/security-panel"));
const TimingsPanel = createFactory(require("./shared/components/timings-panel"));

const HEADERS_SIZE_DECIMALS = 3;
const GENERIC_VARIABLES_VIEW_SETTINGS = {
  lazyEmpty: true,
  // ms
  lazyEmptyDelay: 10,
  searchEnabled: true,
  editableValueTooltip: "",
  editableNameTooltip: "",
  preventDisableOnChange: true,
  preventDescriptorModifiers: true,
  eval: () => {}
};

/**
 * Functions handling the requests details view.
 */
function DetailsView() {
  dumpn("DetailsView was instantiated");

  // The ToolSidebar requires the panel object to be able to emit events.
  EventEmitter.decorate(this);

  this._onTabSelect = this._onTabSelect.bind(this);
}

DetailsView.prototype = {
  /**
   * An object containing the state of tabs.
   */
  _viewState: {
    // if updating[tab] is true a task is currently updating the given tab.
    updating: [],
    // if dirty[tab] is true, the tab needs to be repopulated once current
    // update task finishes
    dirty: [],
    // the most recently received attachment data for the request
    latestData: null,
  },

  /**
   * Initialization function, called when the network monitor is started.
   */
  initialize: function (store) {
    dumpn("Initializing the DetailsView");

    this._paramsPanelNode = $("#react-params-tabpanel-hook");

    ReactDOM.render(Provider(
      { store },
      ParamsPanel()
    ), this._paramsPanelNode);

    this._previewPanelNode = $("#react-preview-tabpanel-hook");

    ReactDOM.render(Provider(
      { store },
      PreviewPanel()
    ), this._previewPanelNode);

    this._responsePanelNode = $("#react-response-tabpanel-hook");

    ReactDOM.render(Provider(
      { store },
      ResponsePanel()
    ), this._responsePanelNode);

    this._securityPanelNode = $("#react-security-tabpanel-hook");

    ReactDOM.render(Provider(
      { store },
      SecurityPanel()
    ), this._securityPanelNode);

    this._timingsPanelNode = $("#react-timings-tabpanel-hook");

    ReactDOM.render(Provider(
      { store },
      TimingsPanel()
    ), this._timingsPanelNode);

    this.widget = $("#event-details-pane");
    this.sidebar = new ToolSidebar(this.widget, this, "netmonitor", {
      disableTelemetry: true,
      showAllTabsMenu: true
    });

    this._headers = new VariablesView($("#all-headers"),
      Heritage.extend(GENERIC_VARIABLES_VIEW_SETTINGS, {
        emptyText: L10N.getStr("headersEmptyText"),
        searchPlaceholder: L10N.getStr("headersFilterText")
      }));
    this._cookies = new VariablesView($("#all-cookies"),
      Heritage.extend(GENERIC_VARIABLES_VIEW_SETTINGS, {
        emptyText: L10N.getStr("cookiesEmptyText"),
        searchPlaceholder: L10N.getStr("cookiesFilterText")
      }));

    this._requestHeaders = L10N.getStr("requestHeaders");
    this._requestHeadersFromUpload = L10N.getStr("requestHeadersFromUpload");
    this._responseHeaders = L10N.getStr("responseHeaders");
    this._requestCookies = L10N.getStr("requestCookies");
    this._responseCookies = L10N.getStr("responseCookies");

    $("tabpanels", this.widget).addEventListener("select", this._onTabSelect);
  },

  /**
   * Destruction function, called when the network monitor is closed.
   */
  destroy: function () {
    dumpn("Destroying the DetailsView");
    ReactDOM.unmountComponentAtNode(this._paramsPanelNode);
    ReactDOM.unmountComponentAtNode(this._previewPanelNode);
    ReactDOM.unmountComponentAtNode(this._responsePanelNode);
    ReactDOM.unmountComponentAtNode(this._securityPanelNode);
    ReactDOM.unmountComponentAtNode(this._timingsPanelNode);
    this.sidebar.destroy();
    $("tabpanels", this.widget).removeEventListener("select",
      this._onTabSelect);
  },

  /**
   * Populates this view with the specified data.
   *
   * @param object data
   *        The data source (this should be the attachment of a request item).
   * @return object
   *        Returns a promise that resolves upon population the view.
   */
  populate: function (data) {
    $("#raw-headers").hidden = true;

    let isHtml = Filters.html(data);

    // Show the "Preview" tabpanel only for plain HTML responses.
    this.sidebar.toggleTab(isHtml, "preview-tab");

    // Show the "Security" tab only for requests that
    //   1) are https (state != insecure)
    //   2) come from a target that provides security information.
    let hasSecurityInfo = data.securityState &&
                          data.securityState !== "insecure";
    this.sidebar.toggleTab(hasSecurityInfo, "security-tab");

    // Switch to the "Headers" tabpanel if the "Preview" previously selected
    // and this is not an HTML response or "Security" was selected but this
    // request has no security information.

    if (!isHtml && this.widget.selectedPanel === $("#preview-tabpanel") ||
        !hasSecurityInfo && this.widget.selectedPanel ===
          $("#security-tabpanel")) {
      this.widget.selectedIndex = 0;
    }

    this._headers.empty();
    this._cookies.empty();

    this._dataSrc = { src: data, populated: [] };
    this._onTabSelect();
    window.emit(EVENTS.NETWORKDETAILSVIEW_POPULATED);

    return promise.resolve();
  },

  /**
   * Listener handling the tab selection event.
   */
  _onTabSelect: function () {
    let { src, populated } = this._dataSrc || {};
    let tab = this.widget.selectedIndex;
    let view = this;

    // Make sure the data source is valid and don't populate the same tab twice.
    if (!src || populated[tab]) {
      return;
    }

    let viewState = this._viewState;
    if (viewState.updating[tab]) {
      // A task is currently updating this tab. If we started another update
      // task now it would result in a duplicated content as described in bugs
      // 997065 and 984687. As there's no way to stop the current task mark the
      // tab dirty and refresh the panel once the current task finishes.
      viewState.dirty[tab] = true;
      viewState.latestData = src;
      return;
    }

    Task.spawn(function* () {
      viewState.updating[tab] = true;
      switch (tab) {
        // "Headers"
        case 0:
          yield view._setSummary(src);
          yield view._setResponseHeaders(src.responseHeaders);
          yield view._setRequestHeaders(
            src.requestHeaders,
            src.requestHeadersFromUploadStream);
          break;
        // "Cookies"
        case 1:
          yield view._setResponseCookies(src.responseCookies);
          yield view._setRequestCookies(src.requestCookies);
          break;
      }
      viewState.updating[tab] = false;
    }).then(() => {
      if (tab == this.widget.selectedIndex) {
        if (viewState.dirty[tab]) {
          // The request information was updated while the task was running.
          viewState.dirty[tab] = false;
          view.populate(viewState.latestData);
        } else {
          // Tab is selected but not dirty. We're done here.
          populated[tab] = true;
          window.emit(EVENTS.TAB_UPDATED);
        }
      } else if (viewState.dirty[tab]) {
        // Tab is dirty but no longer selected. Don't refresh it now, it'll be
        // done if the tab is shown again.
        viewState.dirty[tab] = false;
      }
    }, e => console.error(e));
  },

  /**
   * Sets the network request summary shown in this view.
   *
   * @param object data
   *        The data source (this should be the attachment of a request item).
   */
  _setSummary: function (data) {
    if (data.url) {
      let unicodeUrl = decodeUnicodeUrl(data.url);
      $("#headers-summary-url-value").setAttribute("value", unicodeUrl);
      $("#headers-summary-url-value").setAttribute("tooltiptext", unicodeUrl);
      $("#headers-summary-url").removeAttribute("hidden");
    } else {
      $("#headers-summary-url").setAttribute("hidden", "true");
    }

    if (data.method) {
      $("#headers-summary-method-value").setAttribute("value", data.method);
      $("#headers-summary-method").removeAttribute("hidden");
    } else {
      $("#headers-summary-method").setAttribute("hidden", "true");
    }

    if (data.remoteAddress) {
      let address = data.remoteAddress;
      if (address.indexOf(":") != -1) {
        address = `[${address}]`;
      }
      if (data.remotePort) {
        address += `:${data.remotePort}`;
      }
      $("#headers-summary-address-value").setAttribute("value", address);
      $("#headers-summary-address-value").setAttribute("tooltiptext", address);
      $("#headers-summary-address").removeAttribute("hidden");
    } else {
      $("#headers-summary-address").setAttribute("hidden", "true");
    }

    if (data.status) {
      // "code" attribute is only used by css to determine the icon color
      let code;
      if (data.fromCache) {
        code = "cached";
      } else if (data.fromServiceWorker) {
        code = "service worker";
      } else {
        code = data.status;
      }
      $("#headers-summary-status-circle").setAttribute("data-code", code);
      $("#headers-summary-status-value").setAttribute("value",
        data.status + " " + data.statusText);
      $("#headers-summary-status").removeAttribute("hidden");
    } else {
      $("#headers-summary-status").setAttribute("hidden", "true");
    }

    if (data.httpVersion) {
      $("#headers-summary-version-value").setAttribute("value",
        data.httpVersion);
      $("#headers-summary-version").removeAttribute("hidden");
    } else {
      $("#headers-summary-version").setAttribute("hidden", "true");
    }
  },

  /**
   * Sets the network request headers shown in this view.
   *
   * @param object headers
   *        The "requestHeaders" message received from the server.
   * @param object uploadHeaders
   *        The "requestHeadersFromUploadStream" inferred from the POST payload.
   * @return object
   *        A promise that resolves when request headers are set.
   */
  _setRequestHeaders: Task.async(function* (headers, uploadHeaders) {
    if (headers && headers.headers.length) {
      yield this._addHeaders(this._requestHeaders, headers);
    }
    if (uploadHeaders && uploadHeaders.headers.length) {
      yield this._addHeaders(this._requestHeadersFromUpload, uploadHeaders);
    }
  }),

  /**
   * Sets the network response headers shown in this view.
   *
   * @param object response
   *        The message received from the server.
   * @return object
   *        A promise that resolves when response headers are set.
   */
  _setResponseHeaders: Task.async(function* (response) {
    if (response && response.headers.length) {
      response.headers.sort((a, b) => a.name > b.name);
      yield this._addHeaders(this._responseHeaders, response);
    }
  }),

  /**
   * Populates the headers container in this view with the specified data.
   *
   * @param string name
   *        The type of headers to populate (request or response).
   * @param object response
   *        The message received from the server.
   * @return object
   *        A promise that resolves when headers are added.
   */
  _addHeaders: Task.async(function* (name, response) {
    let kb = response.headersSize / 1024;
    let size = L10N.numberWithDecimals(kb, HEADERS_SIZE_DECIMALS);
    let text = L10N.getFormatStr("networkMenu.sizeKB", size);

    let headersScope = this._headers.addScope(name + " (" + text + ")");
    headersScope.expanded = true;

    for (let header of response.headers) {
      let headerVar = headersScope.addItem(header.name, {}, {relaxed: true});
      let headerValue = yield gNetwork.getString(header.value);
      headerVar.setGrip(headerValue);
    }
  }),

  /**
   * Sets the network request cookies shown in this view.
   *
   * @param object response
   *        The message received from the server.
   * @return object
   *        A promise that is resolved when the request cookies are set.
   */
  _setRequestCookies: Task.async(function* (response) {
    if (response && response.cookies.length) {
      response.cookies.sort((a, b) => a.name > b.name);
      yield this._addCookies(this._requestCookies, response);
    }
  }),

  /**
   * Sets the network response cookies shown in this view.
   *
   * @param object response
   *        The message received from the server.
   * @return object
   *        A promise that is resolved when the response cookies are set.
   */
  _setResponseCookies: Task.async(function* (response) {
    if (response && response.cookies.length) {
      yield this._addCookies(this._responseCookies, response);
    }
  }),

  /**
   * Populates the cookies container in this view with the specified data.
   *
   * @param string name
   *        The type of cookies to populate (request or response).
   * @param object response
   *        The message received from the server.
   * @return object
   *        Returns a promise that resolves upon the adding of cookies.
   */
  _addCookies: Task.async(function* (name, response) {
    let cookiesScope = this._cookies.addScope(name);
    cookiesScope.expanded = true;

    for (let cookie of response.cookies) {
      let cookieVar = cookiesScope.addItem(cookie.name, {}, {relaxed: true});
      let cookieValue = yield gNetwork.getString(cookie.value);
      cookieVar.setGrip(cookieValue);

      // By default the cookie name and value are shown. If this is the only
      // information available, then nothing else is to be displayed.
      let cookieProps = Object.keys(cookie);
      if (cookieProps.length == 2) {
        continue;
      }

      // Display any other information other than the cookie name and value
      // which may be available.
      let rawObject = Object.create(null);
      let otherProps = cookieProps.filter(e => e != "name" && e != "value");
      for (let prop of otherProps) {
        rawObject[prop] = cookie[prop];
      }
      cookieVar.populate(rawObject);
      cookieVar.twisty = true;
      cookieVar.expanded = true;
    }
  }),

  _dataSrc: null,
  _headers: null,
  _cookies: null,
  _requestHeaders: "",
  _responseHeaders: "",
  _requestCookies: "",
  _responseCookies: ""
};

exports.DetailsView = DetailsView;
