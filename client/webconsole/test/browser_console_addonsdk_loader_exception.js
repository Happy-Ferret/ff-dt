/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* vim: set ft=javascript ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Check that exceptions from scripts loaded with the addon-sdk loader are
// opened correctly in View Source from the Browser Console.
// See bug 866950.

"use strict";

const TEST_URI = "data:text/html;charset=utf8,<p>hello world from bug 866950";

function test() {
  requestLongerTimeout(2);

  let webconsole, browserconsole;

  Task.spawn(runner).then(finishTest);

  function* runner() {
    let {tab} = yield loadTab(TEST_URI);
    webconsole = yield openConsole(tab);
    ok(webconsole, "web console opened");

    browserconsole = yield HUDService.toggleBrowserConsole();
    ok(browserconsole, "browser console opened");

    // Cause an exception in a script loaded with the addon-sdk loader.
    let toolbox = gDevTools.getToolbox(webconsole.target);
    let oldPanels = toolbox._toolPanels;
    // non-iterable
    toolbox._toolPanels = {};

    function fixToolbox() {
      toolbox._toolPanels = oldPanels;
    }

    info("generate exception and wait for message");

    executeSoon(() => {
      executeSoon(fixToolbox);
      expectUncaughtException();
      toolbox.getToolPanels();
    });

    let [result] = yield waitForMessages({
      webconsole: browserconsole,
      messages: [{
        text: "TypeError: this._toolPanels is not iterable",
        category: CATEGORY_JS,
        severity: SEVERITY_ERROR,
      }],
    });

    fixToolbox();

    let msg = [...result.matched][0];
    ok(msg, "message element found");
    let locationNode = msg.querySelector(".message > .message-location");
    ok(locationNode, "message location element found");

    let title = locationNode.getAttribute("title");
    info("location node title: " + title);
    isnot(title.indexOf(" -> "), -1, "error comes from a subscript");

    let viewSource = browserconsole.viewSource;
    let URL = null;
    let clickPromise = promise.defer();
    browserconsole.viewSourceInDebugger = (aURL) => {
      info("browserconsole.viewSourceInDebugger() was invoked: " + aURL);
      URL = aURL;
      clickPromise.resolve(null);
    };

    msg.scrollIntoView();
    EventUtils.synthesizeMouse(locationNode, 2, 2, {},
                               browserconsole.iframeWindow);

    info("wait for click on locationNode");
    yield clickPromise.promise;

    info("view-source url: " + URL);
    ok(URL, "we have some source URL after the click");
    isnot(URL.indexOf("toolbox.js"), -1, "we have the expected view source URL");
    is(URL.indexOf("->"), -1, "no -> in the URL given to view-source");

    browserconsole.viewSourceInDebugger = viewSource;
  }
}
