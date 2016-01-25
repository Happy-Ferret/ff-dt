/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* vim: set ft=javascript ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const INIT_URI = "data:text/html;charset=utf-8,Web Console - bug 600183 test";
const TEST_URI = "http://example.com/browser/devtools/client/webconsole/" +
                 "test/test-bug-600183-charset.html";

function performTest(lastFinishedRequest, console) {
  let deferred = promise.defer();

  ok(lastFinishedRequest, "charset test page was loaded and logged");
  HUDService.lastFinishedRequest.callback = null;

  executeSoon(() => {
    console.webConsoleClient.getResponseContent(lastFinishedRequest.actor,
      (response) => {
        ok(!response.contentDiscarded, "response body was not discarded");

        let body = response.content.text;
        ok(body, "we have the response body");

        // 的问候!
        let chars = "\u7684\u95ee\u5019!";
        isnot(body.indexOf("<p>" + chars + "</p>"), -1,
          "found the chinese simplified string");

        HUDService.lastFinishedRequest.callback = null;
        executeSoon(deferred.resolve);
      });
  });

  return deferred.promise;
}

function waitForRequest() {
  let deferred = promise.defer();
  HUDService.lastFinishedRequest.callback = (req, console) => {
    performTest(req, console).then(deferred.resolve);
  };
  return deferred.promise;
}

add_task(function* () {
  let { browser } = yield loadTab(INIT_URI);

  let hud = yield openConsole();

  let gotLastRequest = waitForRequest();

  let loaded = loadBrowser(browser);
  content.location = TEST_URI;
  yield loaded;

  yield gotLastRequest;
});
