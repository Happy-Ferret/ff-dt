/* vim: set ts=2 et sw=2 tw=80: */
/* Any copyright is dedicated to the Public Domain.
 http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// /////////////////
//
// Whitelisting this test.
// As part of bug 1077403, the leaking uncaught rejection should be fixed.
//
thisTestLeaksUncaughtRejectionsAndShouldBeFixed("destroy");

loadHelperScript("helper_edits.js");

// Test ProjectEditor basic functionality
add_task(function* () {
  let projecteditor = yield addProjectEditorTabForTempDirectory();
  let TEMP_PATH = projecteditor.project.allPaths()[0];

  is(getTempFile("").path, TEMP_PATH, "Temp path is set correctly.");

  ok(projecteditor.currentEditor, "There is an editor for projecteditor");
  let resources = projecteditor.project.allResources();

  for (let data of helperEditData) {
    info("Processing " + data.path);
    let resource = resources.filter(r=>r.basename === data.basename)[0];
    yield selectFile(projecteditor, resource);
    yield editFile(projecteditor, getTempFile(data.path).path, data.newContent);
  }

  info("Saving all resources");
  ok(projecteditor.hasUnsavedResources, "hasUnsavedResources");
  yield projecteditor.saveAllFiles();
  ok(!projecteditor.hasUnsavedResources, "!hasUnsavedResources");
  for (let data of helperEditData) {
    let filePath = getTempFile(data.path).path;
    info("Asserting that data at " + filePath + " has been saved");
    let resource = resources.filter(r=>r.basename === data.basename)[0];
    yield selectFile(projecteditor, resource);
    let editor = projecteditor.currentEditor;
    let savedData = yield getFileData(filePath);
    is(savedData, data.newContent, "Data has been correctly saved to disk");
  }
});

function* editFile(projecteditor, filePath, newData) {
  info("Testing file editing for: " + filePath);

  let initialData = yield getFileData(filePath);
  let editor = projecteditor.currentEditor;
  let resource = projecteditor.resourceFor(editor);
  let viewContainer = projecteditor.projectTree.getViewContainer(resource);
  let originalTreeLabel = viewContainer.label.textContent;

  is(resource.path, filePath, "Resource path is set correctly");
  is(editor.editor.getText(), initialData, "Editor is loaded with correct file contents");

  info("Setting text in the editor");

  editor.editor.setText(newData);
  is(editor.editor.getText(), newData, "Editor has been filled with new data");
  is(viewContainer.label.textContent, "*" + originalTreeLabel, "Label is marked as changed");
}
