/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const { Task } = require("devtools/shared/task");
const { ViewHelpers, setNamedTimeout } = require("devtools/client/shared/widgets/view-helpers");
const { ELLIPSIS } = require("devtools/shared/l10n");

loader.lazyRequireGetter(this, "defer", "devtools/shared/defer");
loader.lazyRequireGetter(this, "EventEmitter",
  "devtools/shared/event-emitter");

loader.lazyRequireGetter(this, "getColor",
  "devtools/client/shared/theme", true);

loader.lazyRequireGetter(this, "CATEGORY_MAPPINGS",
  "devtools/client/performance/modules/categories", true);
loader.lazyRequireGetter(this, "FrameUtils",
  "devtools/client/performance/modules/logic/frame-utils");
loader.lazyRequireGetter(this, "demangle",
  "devtools/client/shared/demangle");

loader.lazyRequireGetter(this, "AbstractCanvasGraph",
  "devtools/client/shared/widgets/Graphs", true);
loader.lazyRequireGetter(this, "GraphArea",
  "devtools/client/shared/widgets/Graphs", true);
loader.lazyRequireGetter(this, "GraphAreaDragger",
  "devtools/client/shared/widgets/Graphs", true);

const GRAPH_SRC = "chrome://devtools/content/shared/widgets/graphs-frame.xhtml";

// ms
const GRAPH_RESIZE_EVENTS_DRAIN = 100;

const GRAPH_WHEEL_ZOOM_SENSITIVITY = 0.00035;
const GRAPH_WHEEL_SCROLL_SENSITIVITY = 0.5;
const GRAPH_KEYBOARD_ZOOM_SENSITIVITY = 20;
const GRAPH_KEYBOARD_PAN_SENSITIVITY = 20;
const GRAPH_KEYBOARD_ACCELERATION = 1.05;
const GRAPH_KEYBOARD_TRANSLATION_MAX = 150;

// ms
const GRAPH_MIN_SELECTION_WIDTH = 0.001;

// px
const GRAPH_HORIZONTAL_PAN_THRESHOLD = 10;
const GRAPH_VERTICAL_PAN_THRESHOLD = 30;

const FIND_OPTIMAL_TICK_INTERVAL_MAX_ITERS = 100;

// ms
const TIMELINE_TICKS_MULTIPLE = 5;
// px
const TIMELINE_TICKS_SPACING_MIN = 75;

// px
const OVERVIEW_HEADER_HEIGHT = 16;
const OVERVIEW_HEADER_TEXT_FONT_SIZE = 9;
const OVERVIEW_HEADER_TEXT_FONT_FAMILY = "sans-serif";
// px
const OVERVIEW_HEADER_TEXT_PADDING_LEFT = 6;
const OVERVIEW_HEADER_TEXT_PADDING_TOP = 5;
const OVERVIEW_HEADER_TIMELINE_STROKE_COLOR = "rgba(128, 128, 128, 0.5)";

// px
const FLAME_GRAPH_BLOCK_HEIGHT = 15;
const FLAME_GRAPH_BLOCK_BORDER = 1;
const FLAME_GRAPH_BLOCK_TEXT_FONT_SIZE = 10;
const FLAME_GRAPH_BLOCK_TEXT_FONT_FAMILY = "message-box, Helvetica Neue," +
                                           "Helvetica, sans-serif";
// px
const FLAME_GRAPH_BLOCK_TEXT_PADDING_TOP = 0;
const FLAME_GRAPH_BLOCK_TEXT_PADDING_LEFT = 3;
const FLAME_GRAPH_BLOCK_TEXT_PADDING_RIGHT = 3;

// Large enough number for a diverse pallette.
const PALLETTE_SIZE = 20;
const PALLETTE_HUE_OFFSET = Math.random() * 90;
const PALLETTE_HUE_RANGE = 270;
const PALLETTE_SATURATION = 100;
const PALLETTE_BRIGHTNESS = 55;
const PALLETTE_OPACITY = 0.35;

const COLOR_PALLETTE = Array.from(Array(PALLETTE_SIZE)).map((_, i) => "hsla" +
  "(" +
  ((PALLETTE_HUE_OFFSET + (i / PALLETTE_SIZE * PALLETTE_HUE_RANGE)) | 0 % 360) +
  "," + PALLETTE_SATURATION + "%" +
  "," + PALLETTE_BRIGHTNESS + "%" +
  "," + PALLETTE_OPACITY +
  ")"
);

/**
 * A flamegraph visualization. This implementation is responsable only with
 * drawing the graph, using a data source consisting of rectangles and
 * their corresponding widths.
 *
 * Example usage:
 *   let graph = new FlameGraph(node);
 *   graph.once("ready", () => {
 *     let data = FlameGraphUtils.createFlameGraphDataFromThread(thread);
 *     let bounds = { startTime, endTime };
 *     graph.setData({ data, bounds });
 *   });
 *
 * Data source format:
 *   [
 *     {
 *       color: "string",
 *       blocks: [
 *         {
 *           x: number,
 *           y: number,
 *           width: number,
 *           height: number,
 *           text: "string"
 *         },
 *         ...
 *       ]
 *     },
 *     {
 *       color: "string",
 *       blocks: [...]
 *     },
 *     ...
 *     {
 *       color: "string",
 *       blocks: [...]
 *     }
 *   ]
 *
 * Use `FlameGraphUtils` to convert profiler data (or any other data source)
 * into a drawable format.
 *
 * @param nsIDOMNode parent
 *        The parent node holding the graph.
 * @param number sharpness [optional]
 *        Defaults to the current device pixel ratio.
 */
function FlameGraph(parent, sharpness) {
  EventEmitter.decorate(this);

  this._parent = parent;
  this._ready = defer();

  this.setTheme();

  AbstractCanvasGraph.createIframe(GRAPH_SRC, parent, iframe => {
    this._iframe = iframe;
    this._window = iframe.contentWindow;
    this._document = iframe.contentDocument;
    this._pixelRatio = sharpness || this._window.devicePixelRatio;

    let container =
      this._container = this._document.getElementById("graph-container");
    container.className = "flame-graph-widget-container graph-widget-container";

    let canvas = this._canvas = this._document.getElementById("graph-canvas");
    canvas.className = "flame-graph-widget-canvas graph-widget-canvas";

    let bounds = parent.getBoundingClientRect();
    bounds.width = this.fixedWidth || bounds.width;
    bounds.height = this.fixedHeight || bounds.height;
    iframe.setAttribute("width", bounds.width);
    iframe.setAttribute("height", bounds.height);

    this._width = canvas.width = bounds.width * this._pixelRatio;
    this._height = canvas.height = bounds.height * this._pixelRatio;
    this._ctx = canvas.getContext("2d");

    this._bounds = new GraphArea();
    this._selection = new GraphArea();
    this._selectionDragger = new GraphAreaDragger();
    this._verticalOffset = 0;
    this._verticalOffsetDragger = new GraphAreaDragger(0);
    this._keyboardZoomAccelerationFactor = 1;
    this._keyboardPanAccelerationFactor = 1;

    this._userInputStack = 0;
    this._keysPressed = [];

    // Calculating text widths is necessary to trim the text inside the blocks
    // while the scaling changes (e.g. via scrolling). This is very expensive,
    // so maintain a cache of string contents to text widths.
    this._textWidthsCache = {};

    let fontSize = FLAME_GRAPH_BLOCK_TEXT_FONT_SIZE * this._pixelRatio;
    let fontFamily = FLAME_GRAPH_BLOCK_TEXT_FONT_FAMILY;
    this._ctx.font = fontSize + "px " + fontFamily;
    this._averageCharWidth = this._calcAverageCharWidth();
    this._overflowCharWidth = this._getTextWidth(this.overflowChar);

    this._onAnimationFrame = this._onAnimationFrame.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onKeyPress = this._onKeyPress.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onMouseWheel = this._onMouseWheel.bind(this);
    this._onResize = this._onResize.bind(this);
    this.refresh = this.refresh.bind(this);

    this._window.addEventListener("keydown", this._onKeyDown);
    this._window.addEventListener("keyup", this._onKeyUp);
    this._window.addEventListener("keypress", this._onKeyPress);
    this._window.addEventListener("mousemove", this._onMouseMove);
    this._window.addEventListener("mousedown", this._onMouseDown);
    this._window.addEventListener("mouseup", this._onMouseUp);
    this._window.addEventListener("MozMousePixelScroll", this._onMouseWheel);

    let ownerWindow = this._parent.ownerDocument.defaultView;
    ownerWindow.addEventListener("resize", this._onResize);

    this._animationId =
      this._window.requestAnimationFrame(this._onAnimationFrame);

    this._ready.resolve(this);
    this.emit("ready", this);
  });
}

FlameGraph.prototype = {
  /**
   * Read-only width and height of the canvas.
   * @return number
   */
  get width() {
    return this._width;
  },
  get height() {
    return this._height;
  },

  /**
   * Returns a promise resolved once this graph is ready to receive data.
   */
  ready() {
    return this._ready.promise;
  },

  /**
   * Destroys this graph.
   */
  destroy: Task.async(function* () {
    yield this.ready();

    this._window.removeEventListener("keydown", this._onKeyDown);
    this._window.removeEventListener("keyup", this._onKeyUp);
    this._window.removeEventListener("keypress", this._onKeyPress);
    this._window.removeEventListener("mousemove", this._onMouseMove);
    this._window.removeEventListener("mousedown", this._onMouseDown);
    this._window.removeEventListener("mouseup", this._onMouseUp);
    this._window.removeEventListener("MozMousePixelScroll", this._onMouseWheel);

    let ownerWindow = this._parent.ownerDocument.defaultView;
    if (ownerWindow) {
      ownerWindow.removeEventListener("resize", this._onResize);
    }

    this._window.cancelAnimationFrame(this._animationId);
    this._iframe.remove();

    this._bounds = null;
    this._selection = null;
    this._selectionDragger = null;
    this._verticalOffset = null;
    this._verticalOffsetDragger = null;
    this._keyboardZoomAccelerationFactor = null;
    this._keyboardPanAccelerationFactor = null;
    this._textWidthsCache = null;

    this._data = null;

    this.emit("destroyed");
  }),

  /**
   * Makes sure the canvas graph is of the specified width or height, and
   * doesn't flex to fit all the available space.
   */
  fixedWidth: null,
  fixedHeight: null,

  /**
   * How much preliminar drag is necessary to determine the panning direction.
   */
  horizontalPanThreshold: GRAPH_HORIZONTAL_PAN_THRESHOLD,
  verticalPanThreshold: GRAPH_VERTICAL_PAN_THRESHOLD,

  /**
   * The units used in the overhead ticks. Could be "ms", for example.
   * Overwrite this with your own localized format.
   */
  timelineTickUnits: "",

  /**
   * Character used when a block's text is overflowing.
   * Defaults to an ellipsis.
   */
  overflowChar: ELLIPSIS,

  /**
   * Sets the data source for this graph.
   *
   * @param object data
   *        An object containing the following properties:
   *          - data: the data source; see the constructor for more info
   *          - bounds: the minimum/maximum { start, end }, in ms or px
   *          - visible: optional, the shown { start, end }, in ms or px
   */
  setData({ data, bounds, visible }) {
    this._data = data;
    this.setOuterBounds(bounds);
    this.setViewRange(visible || bounds);
  },

  /**
   * Same as `setData`, but waits for this graph to finish initializing first.
   *
   * @param object data
   *        The data source. See the constructor for more information.
   * @return promise
   *         A promise resolved once the data is set.
   */
  setDataWhenReady: Task.async(function* (data) {
    yield this.ready();
    this.setData(data);
  }),

  /**
   * Gets whether or not this graph has a data source.
   * @return boolean
   */
  hasData() {
    return !!this._data;
  },

  /**
   * Sets the maximum selection (i.e. the 'graph bounds').
   * @param object { start, end }
   */
  setOuterBounds({ startTime, endTime }) {
    this._bounds.start = startTime * this._pixelRatio;
    this._bounds.end = endTime * this._pixelRatio;
    this._shouldRedraw = true;
  },

  /**
   * Sets the selection and vertical offset (i.e. the 'view range').
   * @return number
   */
  setViewRange({ startTime, endTime }, verticalOffset = 0) {
    this._selection.start = startTime * this._pixelRatio;
    this._selection.end = endTime * this._pixelRatio;
    this._verticalOffset = verticalOffset * this._pixelRatio;
    this._shouldRedraw = true;
  },

  /**
   * Gets the maximum selection (i.e. the 'graph bounds').
   * @return number
   */
  getOuterBounds() {
    return {
      startTime: this._bounds.start / this._pixelRatio,
      endTime: this._bounds.end / this._pixelRatio
    };
  },

  /**
   * Gets the current selection and vertical offset (i.e. the 'view range').
   * @return number
   */
  getViewRange() {
    return {
      startTime: this._selection.start / this._pixelRatio,
      endTime: this._selection.end / this._pixelRatio,
      verticalOffset: this._verticalOffset / this._pixelRatio
    };
  },

  /**
   * Focuses this graph's iframe window.
   */
  focus() {
    this._window.focus();
  },

  /**
   * Updates this graph to reflect the new dimensions of the parent node.
   *
   * @param boolean options.force
   *        Force redraw everything.
   */
  refresh(options = {}) {
    let bounds = this._parent.getBoundingClientRect();
    let newWidth = this.fixedWidth || bounds.width;
    let newHeight = this.fixedHeight || bounds.height;

    // Prevent redrawing everything if the graph's width & height won't change,
    // except if force=true.
    if (!options.force &&
        this._width == newWidth * this._pixelRatio &&
        this._height == newHeight * this._pixelRatio) {
      this.emit("refresh-cancelled");
      return;
    }

    bounds.width = newWidth;
    bounds.height = newHeight;
    this._iframe.setAttribute("width", bounds.width);
    this._iframe.setAttribute("height", bounds.height);
    this._width = this._canvas.width = bounds.width * this._pixelRatio;
    this._height = this._canvas.height = bounds.height * this._pixelRatio;

    this._shouldRedraw = true;
    this.emit("refresh");
  },

  /**
   * Sets the theme via `theme` to either "light" or "dark",
   * and updates the internal styling to match. Requires a redraw
   * to see the effects.
   */
  setTheme(theme) {
    theme = theme || "light";
    this.overviewHeaderBackgroundColor = getColor("body-background", theme);
    this.overviewHeaderTextColor = getColor("body-color", theme);
    // Hard to get a color that is readable across both themes for the text
    // on the flames
    this.blockTextColor = getColor(theme === "dark" ? "selection-color"
                                                    : "body-color", theme);
  },

  /**
   * The contents of this graph are redrawn only when something changed,
   * like the data source, or the selection bounds etc. This flag tracks
   * if the rendering is "dirty" and needs to be refreshed.
   */
  _shouldRedraw: false,

  /**
   * Animation frame callback, invoked on each tick of the refresh driver.
   */
  _onAnimationFrame() {
    this._animationId =
      this._window.requestAnimationFrame(this._onAnimationFrame);
    this._drawWidget();
  },

  /**
   * Redraws the widget when necessary. The actual graph is not refreshed
   * every time this function is called, only the cliphead, selection etc.
   */
  _drawWidget() {
    if (!this._shouldRedraw) {
      return;
    }

    // Unlike mouse events which are updated as needed in their own respective
    // handlers, keyboard events are granular and non-continuous (not even
    // "keydown", which is fired with a low frequency). Therefore, to maintain
    // animation smoothness, update anything that's controllable via the
    // keyboard here, in the animation loop, before any actual drawing.
    this._keyboardUpdateLoop();

    let ctx = this._ctx;
    let canvasWidth = this._width;
    let canvasHeight = this._height;
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    let selection = this._selection;
    let selectionWidth = selection.end - selection.start;
    let selectionScale = canvasWidth / selectionWidth;
    this._drawTicks(selection.start, selectionScale);
    this._drawPyramid(this._data, this._verticalOffset,
                      selection.start, selectionScale);
    this._drawHeader(selection.start, selectionScale);

    // If the user isn't doing anything anymore, it's safe to stop drawing.
    // XXX: This doesn't handle cases where we should still be drawing even
    // if any input stops (e.g. smooth panning transitions after the user
    // finishes input). We don't care about that right now.
    if (this._userInputStack == 0) {
      this._shouldRedraw = false;
      return;
    }
    if (this._userInputStack < 0) {
      throw new Error("The user went back in time from a pyramid.");
    }
  },

  /**
   * Performs any necessary changes to the graph's state based on the
   * user's input on a keyboard.
   */
  _keyboardUpdateLoop() {
    const KEY_CODE_UP = 38;
    const KEY_CODE_DOWN = 40;
    const KEY_CODE_LEFT = 37;
    const KEY_CODE_RIGHT = 39;
    const KEY_CODE_W = 87;
    const KEY_CODE_A = 65;
    const KEY_CODE_S = 83;
    const KEY_CODE_D = 68;

    let canvasWidth = this._width;
    let pressed = this._keysPressed;

    let selection = this._selection;
    let selectionWidth = selection.end - selection.start;
    let selectionScale = canvasWidth / selectionWidth;

    let translation = [0, 0];
    let isZooming = false;
    let isPanning = false;

    if (pressed[KEY_CODE_UP] || pressed[KEY_CODE_W]) {
      translation[0] += GRAPH_KEYBOARD_ZOOM_SENSITIVITY / selectionScale;
      translation[1] -= GRAPH_KEYBOARD_ZOOM_SENSITIVITY / selectionScale;
      isZooming = true;
    }
    if (pressed[KEY_CODE_DOWN] || pressed[KEY_CODE_S]) {
      translation[0] -= GRAPH_KEYBOARD_ZOOM_SENSITIVITY / selectionScale;
      translation[1] += GRAPH_KEYBOARD_ZOOM_SENSITIVITY / selectionScale;
      isZooming = true;
    }
    if (pressed[KEY_CODE_LEFT] || pressed[KEY_CODE_A]) {
      translation[0] -= GRAPH_KEYBOARD_PAN_SENSITIVITY / selectionScale;
      translation[1] -= GRAPH_KEYBOARD_PAN_SENSITIVITY / selectionScale;
      isPanning = true;
    }
    if (pressed[KEY_CODE_RIGHT] || pressed[KEY_CODE_D]) {
      translation[0] += GRAPH_KEYBOARD_PAN_SENSITIVITY / selectionScale;
      translation[1] += GRAPH_KEYBOARD_PAN_SENSITIVITY / selectionScale;
      isPanning = true;
    }

    if (isPanning) {
      // Accelerate the left/right selection panning continuously
      // while the pan keys are pressed.
      this._keyboardPanAccelerationFactor *= GRAPH_KEYBOARD_ACCELERATION;
      translation[0] *= this._keyboardPanAccelerationFactor;
      translation[1] *= this._keyboardPanAccelerationFactor;
    } else {
      this._keyboardPanAccelerationFactor = 1;
    }

    if (isZooming) {
      // Accelerate the in/out selection zooming continuously
      // while the zoom keys are pressed.
      this._keyboardZoomAccelerationFactor *= GRAPH_KEYBOARD_ACCELERATION;
      translation[0] *= this._keyboardZoomAccelerationFactor;
      translation[1] *= this._keyboardZoomAccelerationFactor;
    } else {
      this._keyboardZoomAccelerationFactor = 1;
    }

    if (translation[0] != 0 || translation[1] != 0) {
      // Make sure the panning translation speed doesn't end up
      // being too high.
      let maxTranslation = GRAPH_KEYBOARD_TRANSLATION_MAX / selectionScale;
      if (Math.abs(translation[0]) > maxTranslation) {
        translation[0] = Math.sign(translation[0]) * maxTranslation;
      }
      if (Math.abs(translation[1]) > maxTranslation) {
        translation[1] = Math.sign(translation[1]) * maxTranslation;
      }
      this._selection.start += translation[0];
      this._selection.end += translation[1];
      this._normalizeSelectionBounds();
      this.emit("selecting");
    }
  },

  /**
   * Draws the overhead header, with time markers and ticks in this graph.
   *
   * @param number dataOffset, dataScale
   *        Offsets and scales the data source by the specified amount.
   *        This is used for scrolling the visualization.
   */
  _drawHeader(dataOffset, dataScale) {
    let ctx = this._ctx;
    let canvasWidth = this._width;
    let headerHeight = OVERVIEW_HEADER_HEIGHT * this._pixelRatio;

    ctx.fillStyle = this.overviewHeaderBackgroundColor;
    ctx.fillRect(0, 0, canvasWidth, headerHeight);

    this._drawTicks(dataOffset, dataScale, {
      from: 0,
      to: headerHeight,
      renderText: true
    });
  },

  /**
   * Draws the overhead ticks in this graph in the flame graph area.
   *
   * @param number dataOffset, dataScale, from, to, renderText
   *        Offsets and scales the data source by the specified amount.
   *        from and to determine the Y position of how far the stroke
   *        should be drawn.
   *        This is used when scrolling the visualization.
   */
  _drawTicks(dataOffset, dataScale, options) {
    let { from, to, renderText } = options || {};
    let ctx = this._ctx;
    let canvasWidth = this._width;
    let canvasHeight = this._height;
    let scaledOffset = dataOffset * dataScale;

    let fontSize = OVERVIEW_HEADER_TEXT_FONT_SIZE * this._pixelRatio;
    let fontFamily = OVERVIEW_HEADER_TEXT_FONT_FAMILY;
    let textPaddingLeft = OVERVIEW_HEADER_TEXT_PADDING_LEFT * this._pixelRatio;
    let textPaddingTop = OVERVIEW_HEADER_TEXT_PADDING_TOP * this._pixelRatio;
    let tickInterval = this._findOptimalTickInterval(dataScale);

    ctx.textBaseline = "top";
    ctx.font = fontSize + "px " + fontFamily;
    ctx.fillStyle = this.overviewHeaderTextColor;
    ctx.strokeStyle = OVERVIEW_HEADER_TIMELINE_STROKE_COLOR;
    ctx.beginPath();

    for (let x = -scaledOffset % tickInterval; x < canvasWidth;
         x += tickInterval) {
      let lineLeft = x;
      let textLeft = lineLeft + textPaddingLeft;
      let time = Math.round((x / dataScale + dataOffset) / this._pixelRatio);
      let label = time + " " + this.timelineTickUnits;
      if (renderText) {
        ctx.fillText(label, textLeft, textPaddingTop);
      }
      ctx.moveTo(lineLeft, from || 0);
      ctx.lineTo(lineLeft, to || canvasHeight);
    }

    ctx.stroke();
  },

  /**
   * Draws the blocks and text in this graph.
   *
   * @param object dataSource
   *        The data source. See the constructor for more information.
   * @param number verticalOffset
   *        Offsets the drawing vertically by the specified amount.
   * @param number dataOffset, dataScale
   *        Offsets and scales the data source by the specified amount.
   *        This is used for scrolling the visualization.
   */
  _drawPyramid(dataSource, verticalOffset, dataOffset, dataScale) {
    let ctx = this._ctx;

    let fontSize = FLAME_GRAPH_BLOCK_TEXT_FONT_SIZE * this._pixelRatio;
    let fontFamily = FLAME_GRAPH_BLOCK_TEXT_FONT_FAMILY;
    let visibleBlocksInfo = this._drawPyramidFill(dataSource, verticalOffset,
                                                  dataOffset, dataScale);

    ctx.textBaseline = "middle";
    ctx.font = fontSize + "px " + fontFamily;
    ctx.fillStyle = this.blockTextColor;

    this._drawPyramidText(visibleBlocksInfo, verticalOffset,
                          dataOffset, dataScale);
  },

  /**
   * Fills all block inside this graph's pyramid.
   * @see FlameGraph.prototype._drawPyramid
   */
  _drawPyramidFill(dataSource, verticalOffset, dataOffset,
                              dataScale) {
    let visibleBlocksInfoStore = [];
    let minVisibleBlockWidth = this._overflowCharWidth;

    for (let { color, blocks } of dataSource) {
      this._drawBlocksFill(
        color, blocks, verticalOffset, dataOffset, dataScale,
        visibleBlocksInfoStore, minVisibleBlockWidth);
    }

    return visibleBlocksInfoStore;
  },

  /**
   * Adds the text for all block inside this graph's pyramid.
   * @see FlameGraph.prototype._drawPyramid
   */
  _drawPyramidText(blocksInfo, verticalOffset, dataOffset,
                              dataScale) {
    for (let { block, rect } of blocksInfo) {
      this._drawBlockText(block, rect, verticalOffset, dataOffset, dataScale);
    }
  },

  /**
   * Fills a group of blocks sharing the same style.
   *
   * @param string color
   *        The color used as the block's background.
   * @param array blocks
   *        A list of { x, y, width, height } objects visually representing
   *        all the blocks sharing this particular style.
   * @param number verticalOffset
   *        Offsets the drawing vertically by the specified amount.
   * @param number dataOffset, dataScale
   *        Offsets and scales the data source by the specified amount.
   *        This is used for scrolling the visualization.
   * @param array visibleBlocksInfoStore
   *        An array to store all the visible blocks into, along with the
   *        final baked coordinates and dimensions, after drawing them.
   *        The provided array will be populated.
   * @param number minVisibleBlockWidth
   *        The minimum width of the blocks that will be added into
   *        the `visibleBlocksInfoStore`.
   */
  _drawBlocksFill(
    color, blocks, verticalOffset, dataOffset, dataScale,
    visibleBlocksInfoStore, minVisibleBlockWidth) {
    let ctx = this._ctx;
    let canvasWidth = this._width;
    let canvasHeight = this._height;
    let scaledOffset = dataOffset * dataScale;

    ctx.fillStyle = color;
    ctx.beginPath();

    for (let block of blocks) {
      let { x, y, width, height } = block;
      let rectLeft = x * this._pixelRatio * dataScale - scaledOffset;
      let rectTop = (y - verticalOffset + OVERVIEW_HEADER_HEIGHT)
                    * this._pixelRatio;
      let rectWidth = width * this._pixelRatio * dataScale;
      let rectHeight = height * this._pixelRatio;

      // Too far respectively right/left/bottom/top
      if (rectLeft > canvasWidth ||
          rectLeft < -rectWidth ||
          rectTop > canvasHeight ||
          rectTop < -rectHeight) {
        continue;
      }

      // Clamp the blocks position to start at 0. Avoid negative X coords,
      // to properly place the text inside the blocks.
      if (rectLeft < 0) {
        rectWidth += rectLeft;
        rectLeft = 0;
      }

      // Avoid drawing blocks that are too narrow.
      if (rectWidth <= FLAME_GRAPH_BLOCK_BORDER ||
          rectHeight <= FLAME_GRAPH_BLOCK_BORDER) {
        continue;
      }

      ctx.rect(
        rectLeft, rectTop,
        rectWidth - FLAME_GRAPH_BLOCK_BORDER,
        rectHeight - FLAME_GRAPH_BLOCK_BORDER);

      // Populate the visible blocks store with this block if the width
      // is longer than a given threshold.
      if (rectWidth > minVisibleBlockWidth) {
        visibleBlocksInfoStore.push({
          block,
          rect: { rectLeft, rectTop, rectWidth, rectHeight }
        });
      }
    }

    ctx.fill();
  },

  /**
   * Adds text for a single block.
   *
   * @param object block
   *        A single { x, y, width, height, text } object visually representing
   *        the block containing the text.
   * @param object rect
   *        A single { rectLeft, rectTop, rectWidth, rectHeight } object
   *        representing the final baked coordinates of the drawn rectangle.
   *        Think of them as screen-space values, vs. object-space values. These
   *        differ from the scalars in `block` when the graph is scaled/panned.
   * @param number verticalOffset
   *        Offsets the drawing vertically by the specified amount.
   * @param number dataOffset, dataScale
   *        Offsets and scales the data source by the specified amount.
   *        This is used for scrolling the visualization.
   */
  _drawBlockText(block, rect, verticalOffset, dataOffset,
                            dataScale) {
    let ctx = this._ctx;

    let { text } = block;
    let { rectLeft, rectTop, rectWidth, rectHeight } = rect;

    let paddingTop = FLAME_GRAPH_BLOCK_TEXT_PADDING_TOP * this._pixelRatio;
    let paddingLeft = FLAME_GRAPH_BLOCK_TEXT_PADDING_LEFT * this._pixelRatio;
    let paddingRight = FLAME_GRAPH_BLOCK_TEXT_PADDING_RIGHT * this._pixelRatio;
    let totalHorizontalPadding = paddingLeft + paddingRight;

    // Clamp the blocks position to start at 0. Avoid negative X coords,
    // to properly place the text inside the blocks.
    if (rectLeft < 0) {
      rectWidth += rectLeft;
      rectLeft = 0;
    }

    let textLeft = rectLeft + paddingLeft;
    let textTop = rectTop + rectHeight / 2 + paddingTop;
    let textAvailableWidth = rectWidth - totalHorizontalPadding;

    // Massage the text to fit inside a given width. This clamps the string
    // at the end to avoid overflowing.
    let fittedText = this._getFittedText(text, textAvailableWidth);
    if (fittedText.length < 1) {
      return;
    }

    ctx.fillText(fittedText, textLeft, textTop);
  },

  /**
   * Calculating text widths is necessary to trim the text inside the blocks
   * while the scaling changes (e.g. via scrolling). This is very expensive,
   * so maintain a cache of string contents to text widths.
   */
  _textWidthsCache: null,
  _overflowCharWidth: null,
  _averageCharWidth: null,

  /**
   * Gets the width of the specified text, for the current context state
   * (font size, family etc.).
   *
   * @param string text
   *        The text to analyze.
   * @return number
   *         The text width.
   */
  _getTextWidth(text) {
    let cachedWidth = this._textWidthsCache[text];
    if (cachedWidth) {
      return cachedWidth;
    }
    let metrics = this._ctx.measureText(text);
    return (this._textWidthsCache[text] = metrics.width);
  },

  /**
   * Gets an approximate width of the specified text. This is much faster
   * than `_getTextWidth`, but inexact.
   *
   * @param string text
   *        The text to analyze.
   * @return number
   *         The approximate text width.
   */
  _getTextWidthApprox(text) {
    return text.length * this._averageCharWidth;
  },

  /**
   * Gets the average letter width in the English alphabet, for the current
   * context state (font size, family etc.). This provides a close enough
   * value to use in `_getTextWidthApprox`.
   *
   * @return number
   *         The average letter width.
   */
  _calcAverageCharWidth() {
    let letterWidthsSum = 0;
    // space
    let start = 32;
    // "z"
    let end = 123;

    for (let i = start; i < end; i++) {
      let char = String.fromCharCode(i);
      letterWidthsSum += this._getTextWidth(char);
    }

    return letterWidthsSum / (end - start);
  },

  /**
   * Massage a text to fit inside a given width. This clamps the string
   * at the end to avoid overflowing.
   *
   * @param string text
   *        The text to fit inside the given width.
   * @param number maxWidth
   *        The available width for the given text.
   * @return string
   *         The fitted text.
   */
  _getFittedText(text, maxWidth) {
    let textWidth = this._getTextWidth(text);
    if (textWidth < maxWidth) {
      return text;
    }
    if (this._overflowCharWidth > maxWidth) {
      return "";
    }
    for (let i = 1, len = text.length; i <= len; i++) {
      let trimmedText = text.substring(0, len - i);
      let trimmedWidth = this._getTextWidthApprox(trimmedText)
                         + this._overflowCharWidth;
      if (trimmedWidth < maxWidth) {
        return trimmedText + this.overflowChar;
      }
    }
    return "";
  },

  /**
   * Listener for the "keydown" event on the graph's container.
   */
  _onKeyDown(e) {
    ViewHelpers.preventScrolling(e);

    const hasModifier = e.ctrlKey || e.shiftKey || e.altKey || e.metaKey;

    if (!hasModifier && !this._keysPressed[e.keyCode]) {
      this._keysPressed[e.keyCode] = true;
      this._userInputStack++;
      this._shouldRedraw = true;
    }
  },

  /**
   * Listener for the "keyup" event on the graph's container.
   */
  _onKeyUp(e) {
    ViewHelpers.preventScrolling(e);

    if (this._keysPressed[e.keyCode]) {
      this._keysPressed[e.keyCode] = false;
      this._userInputStack--;
      this._shouldRedraw = true;
    }
  },

  /**
   * Listener for the "keypress" event on the graph's container.
   */
  _onKeyPress(e) {
    ViewHelpers.preventScrolling(e);
  },

  /**
   * Listener for the "mousemove" event on the graph's container.
   */
  _onMouseMove(e) {
    let {mouseX, mouseY} = this._getRelativeEventCoordinates(e);

    let canvasWidth = this._width;

    let selection = this._selection;
    let selectionWidth = selection.end - selection.start;
    let selectionScale = canvasWidth / selectionWidth;

    let horizDrag = this._selectionDragger;
    let vertDrag = this._verticalOffsetDragger;

    // Avoid dragging both horizontally and vertically at the same time,
    // as this doesn't feel natural. Based on a minimum distance, enable either
    // one, and remember the drag direction to offset the mouse coords later.
    if (!this._horizontalDragEnabled && !this._verticalDragEnabled) {
      let horizDiff = Math.abs(horizDrag.origin - mouseX);
      if (horizDiff > this.horizontalPanThreshold) {
        this._horizontalDragDirection = Math.sign(horizDrag.origin - mouseX);
        this._horizontalDragEnabled = true;
      }
      let vertDiff = Math.abs(vertDrag.origin - mouseY);
      if (vertDiff > this.verticalPanThreshold) {
        this._verticalDragDirection = Math.sign(vertDrag.origin - mouseY);
        this._verticalDragEnabled = true;
      }
    }

    if (horizDrag.origin != null && this._horizontalDragEnabled) {
      let relativeX = mouseX + this._horizontalDragDirection *
                               this.horizontalPanThreshold;
      selection.start = horizDrag.anchor.start +
                        (horizDrag.origin - relativeX) / selectionScale;
      selection.end = horizDrag.anchor.end +
                      (horizDrag.origin - relativeX) / selectionScale;
      this._normalizeSelectionBounds();
      this._shouldRedraw = true;
      this.emit("selecting");
    }

    if (vertDrag.origin != null && this._verticalDragEnabled) {
      let relativeY = mouseY +
                      this._verticalDragDirection * this.verticalPanThreshold;
      this._verticalOffset = vertDrag.anchor +
                             (vertDrag.origin - relativeY) / this._pixelRatio;
      this._normalizeVerticalOffset();
      this._shouldRedraw = true;
      this.emit("panning-vertically");
    }
  },

  /**
   * Listener for the "mousedown" event on the graph's container.
   */
  _onMouseDown(e) {
    let {mouseX, mouseY} = this._getRelativeEventCoordinates(e);

    this._selectionDragger.origin = mouseX;
    this._selectionDragger.anchor.start = this._selection.start;
    this._selectionDragger.anchor.end = this._selection.end;

    this._verticalOffsetDragger.origin = mouseY;
    this._verticalOffsetDragger.anchor = this._verticalOffset;

    this._horizontalDragEnabled = false;
    this._verticalDragEnabled = false;

    this._canvas.setAttribute("input", "adjusting-view-area");
  },

  /**
   * Listener for the "mouseup" event on the graph's container.
   */
  _onMouseUp() {
    this._selectionDragger.origin = null;
    this._verticalOffsetDragger.origin = null;
    this._horizontalDragEnabled = false;
    this._horizontalDragDirection = 0;
    this._verticalDragEnabled = false;
    this._verticalDragDirection = 0;
    this._canvas.removeAttribute("input");
  },

  /**
   * Listener for the "wheel" event on the graph's container.
   */
  _onMouseWheel(e) {
    let {mouseX} = this._getRelativeEventCoordinates(e);

    let canvasWidth = this._width;

    let selection = this._selection;
    let selectionWidth = selection.end - selection.start;
    let selectionScale = canvasWidth / selectionWidth;

    switch (e.axis) {
      case e.VERTICAL_AXIS: {
        let distFromStart = mouseX;
        let distFromEnd = canvasWidth - mouseX;
        let vector = e.detail * GRAPH_WHEEL_ZOOM_SENSITIVITY / selectionScale;
        selection.start -= distFromStart * vector;
        selection.end += distFromEnd * vector;
        break;
      }
      case e.HORIZONTAL_AXIS: {
        let vector = e.detail * GRAPH_WHEEL_SCROLL_SENSITIVITY / selectionScale;
        selection.start += vector;
        selection.end += vector;
        break;
      }
    }

    this._normalizeSelectionBounds();
    this._shouldRedraw = true;
    this.emit("selecting");
  },

  /**
   * Makes sure the start and end points of the current selection
   * are withing the graph's visible bounds, and that they form a selection
   * wider than the allowed minimum width.
   */
  _normalizeSelectionBounds() {
    let boundsStart = this._bounds.start;
    let boundsEnd = this._bounds.end;
    let selectionStart = this._selection.start;
    let selectionEnd = this._selection.end;

    if (selectionStart < boundsStart) {
      selectionStart = boundsStart;
    }
    if (selectionEnd < boundsStart) {
      selectionStart = boundsStart;
      selectionEnd = GRAPH_MIN_SELECTION_WIDTH;
    }
    if (selectionEnd > boundsEnd) {
      selectionEnd = boundsEnd;
    }
    if (selectionStart > boundsEnd) {
      selectionEnd = boundsEnd;
      selectionStart = boundsEnd - GRAPH_MIN_SELECTION_WIDTH;
    }
    if (selectionEnd - selectionStart < GRAPH_MIN_SELECTION_WIDTH) {
      let midPoint = (selectionStart + selectionEnd) / 2;
      selectionStart = midPoint - GRAPH_MIN_SELECTION_WIDTH / 2;
      selectionEnd = midPoint + GRAPH_MIN_SELECTION_WIDTH / 2;
    }

    this._selection.start = selectionStart;
    this._selection.end = selectionEnd;
  },

  /**
   * Makes sure that the current vertical offset is within the allowed
   * panning range.
   */
  _normalizeVerticalOffset() {
    this._verticalOffset = Math.max(this._verticalOffset, 0);
  },

  /**
   *
   * Finds the optimal tick interval between time markers in this graph.
   *
   * @param number dataScale
   * @return number
   */
  _findOptimalTickInterval(dataScale) {
    let timingStep = TIMELINE_TICKS_MULTIPLE;
    let spacingMin = TIMELINE_TICKS_SPACING_MIN * this._pixelRatio;
    let maxIters = FIND_OPTIMAL_TICK_INTERVAL_MAX_ITERS;
    let numIters = 0;

    if (dataScale > spacingMin) {
      return dataScale;
    }

    while (true) {
      let scaledStep = dataScale * timingStep;
      if (++numIters > maxIters) {
        return scaledStep;
      }
      if (scaledStep < spacingMin) {
        timingStep <<= 1;
        continue;
      }
      return scaledStep;
    }
  },

  /**
   * Gets the offset of this graph's container relative to the owner window.
   *
   * @return object
   *         The { left, top } offset.
   */
  _getContainerOffset() {
    let node = this._canvas;
    let x = 0;
    let y = 0;

    while ((node = node.offsetParent)) {
      x += node.offsetLeft;
      y += node.offsetTop;
    }

    return { left: x, top: y };
  },

  /**
   * Given a MouseEvent, make it relative to this._canvas.
   * @return object {mouseX,mouseY}
   */
  _getRelativeEventCoordinates(e) {
    // For ease of testing, testX and testY can be passed in as the event
    // object.
    if ("testX" in e && "testY" in e) {
      return {
        mouseX: e.testX * this._pixelRatio,
        mouseY: e.testY * this._pixelRatio
      };
    }

    let offset = this._getContainerOffset();
    let mouseX = (e.clientX - offset.left) * this._pixelRatio;
    let mouseY = (e.clientY - offset.top) * this._pixelRatio;

    return {mouseX, mouseY};
  },

  /**
   * Listener for the "resize" event on the graph's parent node.
   */
  _onResize() {
    if (this.hasData()) {
      setNamedTimeout(this._uid, GRAPH_RESIZE_EVENTS_DRAIN, this.refresh);
    }
  }
};

/**
 * A collection of utility functions converting various data sources
 * into a format drawable by the FlameGraph.
 */
var FlameGraphUtils = {
  _cache: new WeakMap(),

  /**
   * Create data suitable for use with FlameGraph from a profile's samples.
   * Iterate the profile's samples and keep a moving window of stack traces.
   *
   * @param object thread
   *               The raw thread object received from the backend.
   * @param object options
   *               Additional supported options,
   *                 - boolean contentOnly [optional]
   *                 - boolean invertTree [optional]
   *                 - boolean flattenRecursion [optional]
   *                 - string showIdleBlocks [optional]
   * @return object
   *         Data source usable by FlameGraph.
   */
  createFlameGraphDataFromThread(thread, options = {}, out = []) {
    let cached = this._cache.get(thread);
    if (cached) {
      return cached;
    }

    // 1. Create a map of colors to arrays, representing buckets of
    // blocks inside the flame graph pyramid sharing the same style.

    let buckets = Array.from({ length: PALLETTE_SIZE }, () => []);

    // 2. Populate the buckets by iterating over every frame in every sample.

    let { samples, stackTable, frameTable, stringTable } = thread;

    const SAMPLE_STACK_SLOT = samples.schema.stack;
    const SAMPLE_TIME_SLOT = samples.schema.time;

    const STACK_PREFIX_SLOT = stackTable.schema.prefix;
    const STACK_FRAME_SLOT = stackTable.schema.frame;

    const getOrAddInflatedFrame = FrameUtils.getOrAddInflatedFrame;

    let inflatedFrameCache = FrameUtils.getInflatedFrameCache(frameTable);
    let labelCache = Object.create(null);

    let samplesData = samples.data;
    let stacksData = stackTable.data;

    let flattenRecursion = options.flattenRecursion;

    // Reused objects.
    let mutableFrameKeyOptions = {
      contentOnly: options.contentOnly,
      isRoot: false,
      isLeaf: false,
      isMetaCategoryOut: false
    };

    // Take the timestamp of the first sample as prevTime. 0 is incorrect due
    // to circular buffer wraparound. If wraparound happens, then the first
    // sample will have an incorrect, large duration.
    let prevTime = samplesData.length > 0 ? samplesData[0][SAMPLE_TIME_SLOT]
                                          : 0;
    let prevFrames = [];
    let sampleFrames = [];
    let sampleFrameKeys = [];

    for (let i = 1; i < samplesData.length; i++) {
      let sample = samplesData[i];
      let time = sample[SAMPLE_TIME_SLOT];

      let stackIndex = sample[SAMPLE_STACK_SLOT];
      let prevFrameKey;

      let stackDepth = 0;

      // Inflate the stack and keep a moving window of call stacks.
      //
      // For reference, see the similar block comment in
      // ThreadNode.prototype._buildInverted.
      //
      // In a similar fashion to _buildInverted, frames are inflated on the
      // fly while stackwalking the stackTable trie. The exact same frame key
      // is computed in both _buildInverted and here.
      //
      // Unlike _buildInverted, which builds a call tree directly, the flame
      // graph inflates the stack into an array, as it maintains a moving
      // window of stacks over time.
      //
      // Like _buildInverted, the various filtering functions are also inlined
      // into stack inflation loop.
      while (stackIndex !== null) {
        let stackEntry = stacksData[stackIndex];
        let frameIndex = stackEntry[STACK_FRAME_SLOT];

        // Fetch the stack prefix (i.e. older frames) index.
        stackIndex = stackEntry[STACK_PREFIX_SLOT];

        // Inflate the frame.
        let inflatedFrame = getOrAddInflatedFrame(inflatedFrameCache,
                                                  frameIndex, frameTable,
                                                  stringTable);

        mutableFrameKeyOptions.isRoot = stackIndex === null;
        mutableFrameKeyOptions.isLeaf = stackDepth === 0;
        let frameKey = inflatedFrame.getFrameKey(mutableFrameKeyOptions);

        // If not skipping the frame, add it to the current level. The (root)
        // node isn't useful for flame graphs.
        if (frameKey !== "" && frameKey !== "(root)") {
          // If the frame is a meta category, use the category label.
          if (mutableFrameKeyOptions.isMetaCategoryOut) {
            frameKey = CATEGORY_MAPPINGS[frameKey].label;
          }

          sampleFrames[stackDepth] = inflatedFrame;
          sampleFrameKeys[stackDepth] = frameKey;

          // If we shouldn't flatten the current frame into the previous one,
          // increment the stack depth.
          if (!flattenRecursion || frameKey !== prevFrameKey) {
            stackDepth++;
          }

          prevFrameKey = frameKey;
        }
      }

      // Uninvert frames in place if needed.
      if (!options.invertTree) {
        sampleFrames.length = stackDepth;
        sampleFrames.reverse();
        sampleFrameKeys.length = stackDepth;
        sampleFrameKeys.reverse();
      }

      // If no frames are available, add a pseudo "idle" block in between.
      let isIdleFrame = false;
      if (options.showIdleBlocks && stackDepth === 0) {
        sampleFrames[0] = null;
        sampleFrameKeys[0] = options.showIdleBlocks;
        stackDepth = 1;
        isIdleFrame = true;
      }

      // Put each frame in a bucket.
      for (let frameIndex = 0; frameIndex < stackDepth; frameIndex++) {
        let key = sampleFrameKeys[frameIndex];
        let prevFrame = prevFrames[frameIndex];

        // Frames at the same location and the same depth will be reused.
        // If there is a block already created, change its width.
        if (prevFrame && prevFrame.frameKey === key) {
          prevFrame.width = (time - prevFrame.startTime);
        } else {
          // Otherwise, create a new block for this frame at this depth,
          // using a simple location based salt for picking a color.
          let hash = this._getStringHash(key);
          let bucket = buckets[hash % PALLETTE_SIZE];

          let label;
          if (isIdleFrame) {
            label = key;
          } else {
            label = labelCache[key];
            if (!label) {
              label = labelCache[key] =
                this._formatLabel(key, sampleFrames[frameIndex]);
            }
          }

          bucket.push(prevFrames[frameIndex] = {
            startTime: prevTime,
            frameKey: key,
            x: prevTime,
            y: frameIndex * FLAME_GRAPH_BLOCK_HEIGHT,
            width: time - prevTime,
            height: FLAME_GRAPH_BLOCK_HEIGHT,
            text: label
          });
        }
      }

      // Previous frames at stack depths greater than the current sample's
      // maximum need to be nullified. It's nonsensical to reuse them.
      prevFrames.length = stackDepth;
      prevTime = time;
    }

    // 3. Convert the buckets into a data source usable by the FlameGraph.
    // This is a simple conversion from a Map to an Array.

    for (let i = 0; i < buckets.length; i++) {
      out.push({ color: COLOR_PALLETTE[i], blocks: buckets[i] });
    }

    this._cache.set(thread, out);
    return out;
  },

  /**
   * Clears the cached flame graph data created for the given source.
   * @param any source
   */
  removeFromCache(source) {
    this._cache.delete(source);
  },

  /**
   * Very dumb hashing of a string. Used to pick colors from a pallette.
   *
   * @param string input
   * @return number
   */
  _getStringHash(input) {
    const STRING_HASH_PRIME1 = 7;
    const STRING_HASH_PRIME2 = 31;

    let hash = STRING_HASH_PRIME1;

    for (let i = 0, len = input.length; i < len; i++) {
      hash *= STRING_HASH_PRIME2;
      hash += input.charCodeAt(i);

      if (hash > Number.MAX_SAFE_INTEGER / STRING_HASH_PRIME2) {
        return hash;
      }
    }

    return hash;
  },

  /**
   * Takes a frame key and a frame, and returns a string that should be
   * displayed in its flame block.
   *
   * @param string key
   * @param object frame
   * @return string
   */
  _formatLabel(key, frame) {
    let { functionName, fileName, line } =
      FrameUtils.parseLocation(key, frame.line);
    let label = FrameUtils.shouldDemangle(functionName) ? demangle(functionName)
                                                        : functionName;

    if (fileName) {
      label += ` (${fileName}${line != null ? (":" + line) : ""})`;
    }

    return label;
  }
};

exports.FlameGraph = FlameGraph;
exports.FlameGraphUtils = FlameGraphUtils;
exports.PALLETTE_SIZE = PALLETTE_SIZE;
exports.FLAME_GRAPH_BLOCK_HEIGHT = FLAME_GRAPH_BLOCK_HEIGHT;
exports.FLAME_GRAPH_BLOCK_TEXT_FONT_SIZE = FLAME_GRAPH_BLOCK_TEXT_FONT_SIZE;
exports.FLAME_GRAPH_BLOCK_TEXT_FONT_FAMILY = FLAME_GRAPH_BLOCK_TEXT_FONT_FAMILY;
