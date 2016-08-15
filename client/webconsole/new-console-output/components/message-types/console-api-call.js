/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* vim: set ft=javascript ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// React & Redux
const {
  createFactory,
  DOM: dom,
  PropTypes
} = require("devtools/client/shared/vendor/react");
const GripMessageBody = createFactory(require("devtools/client/webconsole/new-console-output/components/grip-message-body").GripMessageBody);
const MessageRepeat = createFactory(require("devtools/client/webconsole/new-console-output/components/message-repeat").MessageRepeat);
const MessageIcon = createFactory(require("devtools/client/webconsole/new-console-output/components/message-icon").MessageIcon);

ConsoleApiCall.displayName = "ConsoleApiCall";

ConsoleApiCall.propTypes = {
  message: PropTypes.object.isRequired,
};

function ConsoleApiCall(props) {
  const { message } = props;
  const {category, severity} = message;

  const messageBody = message.parameters ?
    message.parameters.map((grip) => GripMessageBody({grip})) :
    message.messageText;

  const icon = MessageIcon({severity: severity});
  const repeat = MessageRepeat({repeat: message.repeat});

  const classes = ["message", "cm-s-mozilla"];

  if (category) {
    classes.push(category);
  }

  if (severity) {
    classes.push(severity);
  }

  return dom.div({
    className: classes.join(" ")
  },
    // @TODO add timestamp
    // @TODO add indent if necessary
    icon,
    dom.span({className: "message-body-wrapper"},
      dom.span({},
        dom.span({className: "message-flex-body"},
          dom.span({className: "message-body devtools-monospace"},
            messageBody
          ),
          repeat
        )
      )
    )
  );
}

module.exports.ConsoleApiCall = ConsoleApiCall;
