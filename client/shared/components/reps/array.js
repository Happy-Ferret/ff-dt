/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* vim: set ft=javascript ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Make this available to both AMD and CJS environments
define(function (require, exports, module) {
  // Dependencies
  const React = require("devtools/client/shared/vendor/react");
  const {
    createFactories,
    wrapRender,
  } = require("./rep-utils");
  const { Caption } = createFactories(require("./caption"));
  const { MODE } = require("./constants");

  // Shortcuts
  const DOM = React.DOM;

  /**
   * Renders an array. The array is enclosed by left and right bracket
   * and the max number of rendered items depends on the current mode.
   */
  let ArrayRep = React.createClass({
    displayName: "ArrayRep",

    propTypes: {
      // @TODO Change this to Object.values once it's supported in Node's version of V8
      mode: React.PropTypes.oneOf(Object.keys(MODE).map(key => MODE[key])),
      objectLink: React.PropTypes.func,
      object: React.PropTypes.array.isRequired,
    },

    getTitle(object, context) {
      return "[" + object.length + "]";
    },

    arrayIterator(array, max) {
      let items = [];
      let delim;

      for (let i = 0; i < array.length && i < max; i++) {
        try {
          let value = array[i];

          delim = (i == array.length - 1 ? "" : ", ");

          items.push(ItemRep({
            object: value,
            // Hardcode tiny mode to avoid recursive handling.
            mode: MODE.TINY,
            delim
          }));
        } catch (exc) {
          items.push(ItemRep({
            object: exc,
            mode: MODE.TINY,
            delim
          }));
        }
      }

      if (array.length > max) {
        let objectLink = this.props.objectLink || DOM.span;
        items.push(Caption({
          object: objectLink({
            object: this.props.object
          }, (array.length - max) + " more…")
        }));
      }

      return items;
    },

    /**
     * Returns true if the passed object is an array with additional (custom)
     * properties, otherwise returns false. Custom properties should be
     * displayed in extra expandable section.
     *
     * Example array with a custom property.
     * let arr = [0, 1];
     * arr.myProp = "Hello";
     *
     * @param {Array} array The array object.
     */
    hasSpecialProperties(array) {
      function isInteger(x) {
        let y = parseInt(x, 10);
        if (isNaN(y)) {
          return false;
        }
        return x === y.toString();
      }

      let props = Object.getOwnPropertyNames(array);
      for (let i = 0; i < props.length; i++) {
        let p = props[i];

        // Valid indexes are skipped
        if (isInteger(p)) {
          continue;
        }

        // Ignore standard 'length' property, anything else is custom.
        if (p != "length") {
          return true;
        }
      }

      return false;
    },

    // Event Handlers

    onToggleProperties(event) {
    },

    onClickBracket(event) {
    },

    render: wrapRender(function () {
      let {
        object,
        mode = MODE.SHORT,
      } = this.props;

      let items;
      let brackets;
      let needSpace = function (space) {
        return space ? { left: "[ ", right: " ]"} : { left: "[", right: "]"};
      };

      if (mode === MODE.TINY) {
        let isEmpty = object.length === 0;
        items = [DOM.span({className: "length"}, isEmpty ? "" : object.length)];
        brackets = needSpace(false);
      } else {
        let max = (mode === MODE.SHORT) ? 3 : 10;
        items = this.arrayIterator(object, max);
        brackets = needSpace(items.length > 0);
      }

      let objectLink = this.props.objectLink || DOM.span;

      return (
        DOM.span({
          className: "objectBox objectBox-array"},
          objectLink({
            className: "arrayLeftBracket",
            object
          }, brackets.left),
          ...items,
          objectLink({
            className: "arrayRightBracket",
            object
          }, brackets.right),
          DOM.span({
            className: "arrayProperties",
            role: "group"}
          )
        )
      );
    }),
  });

  /**
   * Renders array item. Individual values are separated by a comma.
   */
  let ItemRep = React.createFactory(React.createClass({
    displayName: "ItemRep",

    propTypes: {
      object: React.PropTypes.any.isRequired,
      delim: React.PropTypes.string.isRequired,
      mode: React.PropTypes.symbol,
    },

    render: wrapRender(function () {
      const { Rep } = createFactories(require("./rep"));

      let object = this.props.object;
      let delim = this.props.delim;
      let mode = this.props.mode;
      return (
        DOM.span({},
          Rep({object, mode}),
          delim
        )
      );
    })
  }));

  function supportsObject(object, type) {
    return Array.isArray(object) ||
      Object.prototype.toString.call(object) === "[object Arguments]";
  }

  // Exports from this module
  exports.ArrayRep = {
    rep: ArrayRep,
    supportsObject
  };
});
