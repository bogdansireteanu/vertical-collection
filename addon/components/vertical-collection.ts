import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { run } from '@ember/runloop';
import { debug } from '../-debug/edge-visualization/debug';

import { scheduler, Token } from 'ember-raf-scheduler';

import {
  keyForItem,
  DynamicRadar,
  StaticRadar,
  Radar,
  objectAt,
} from '../-private';
import { action } from '@ember/object';

interface IVerticalCollectionArgs {
  estimateHeight?: number;
  items?: Array<unknown>;
  staticHeight?: boolean;
  containerSelector?: string;
  bufferSize?: number;
  idForFirstItem?: string;
  renderFromLast?: boolean;
  renderAll?: boolean;
  lastReached: (item: unknown, index: number) => void;
  firstReached: (item: unknown, index: number) => void;
  lastVisibleChanged: (item: unknown, index: number) => void;
  firstVisibleChanged: (item: unknown, index: number) => void;
  [key: string]: unknown;
  initialRenderCount?: number
}

@debug
export default class VerticalCollection extends Component<IVerticalCollectionArgs> {
  token: Token;
  _radar: Radar;
  _scheduledActions: Array<Array<unknown>>;
  _hasAction: Record<string, boolean> | null;
  _prevItemsLength: number;
  _prevFirstKey: string | null;
  _prevLastKey: string | null;
  _nextSendActions: number | null;
  /**
   * Property name used for storing references to each item in items. Accessing this attribute for each item
   * should yield a unique result for every item in the list.
   *
   * @property key
   * @type String
   * @default '@identity'
   */
  @tracked key = '@identity';

  // –––––––––––––– Required Settings

  /**
   * Estimated height of an item to be rendered. Use best guess as this will be used to determine how many items
   * are displayed virtually, before and after the vertical-collection viewport.
   *
   * @property estimateHeight
   * @type Number
   * @required
   */
  get estimateHeight() {
    return this.args.estimateHeight ?? null;
  }

  /**
   * List of objects to svelte-render.
   * Can be called like `{{#vertical-collection <items-array>}}`, since it's the first positional parameter of this component.
   *
   * @property items
   * @type Array
   * @required
   */
  get items() {
    return this.args.items ?? null;
  }

  // –––––––––––––– Optional Settings
  /**
   * Indicates if the occluded items' heights will change or not.
   * If true, the vertical-collection will assume that items' heights are always equal to estimateHeight;
   * this is more performant, but less flexible.
   *
   * @property staticHeight
   * @type Boolean
   */
  get staticHeight() {
    return this.args.staticHeight ?? false;
  }

  /**
   * Indicates whether or not list items in the Radar should be reused on update of virtual components (e.g. scroll).
   * This yields performance benefits because it is not necessary to repopulate the component pool of the radar.
   * Set to false when recycling a component instance has undesirable ramifications including:
   *  - When using `unbound` in a component or sub-component
   *  - When using init for instance state that differs between instances of a component or sub-component
   *      (can move to didInitAttrs to fix this)
   *  - When templates for individual items vary widely or are based on conditionals that are likely to change
   *      (i.e. would defeat any benefits of DOM recycling anyway)
   *
   * @property shouldRecycle
   * @type Boolean
   */
  @tracked shouldRecycle = true;

  /*
   * A selector string that will select the element from
   * which to calculate the viewable height and needed offsets.
   *
   * This element will also have the `scroll` event handler added to it.
   *
   * Usually this element will be the component's immediate parent element,
   * if so, you can leave this null.
   *
   * Set this to "body" to scroll the entire web page.
   */
  get containerSelector() {
    return this.args.containerSelector ?? '*';
  }

  // –––––––––––––– Performance Tuning
  /**
   * The amount of extra items to keep visible on either side of the viewport -- must be greater than 0.
   * Increasing this value is useful when doing infinite scrolling and loading data from a remote service,
   * with the desire to allow records to show as the user scrolls and the backend API takes time to respond.
   *
   * @property bufferSize
   * @type Number
   * @default 1
   */
  get bufferSize() {
    return this.args.bufferSize ?? 1;
  }

  // –––––––––––––– Initial Scroll State
  /**
   * If set, upon initialization the scroll
   * position will be set such that the item
   * with the provided id is at the top left
   * on screen.
   *
   * If the item cannot be found, scrollTop
   * is set to 0.
   * @property idForFirstItem
   */
  get idForFirstItem() {
    return this.args.idForFirstItem ?? null;
  }

  /**
   * If set, if scrollPosition is empty
   * at initialization, the component will
   * render starting at the bottom.
   * @property renderFromLast
   * @type Boolean
   * @default false
   */
  get renderFromLast() {
    return this.args.renderFromLast ?? false;
  }

  /**
   * If set to true, the collection will render all of the items passed into the component.
   * This counteracts the performance benefits of using vertical collection, but has several potential applications,
   * including but not limited to:
   *
   * - It allows for improved accessibility since all elements are rendered and can be picked up by a screen reader.
   * - Can be applied in SEO solutions (i.e. fastboot) where rendering every item is desirable.
   * - Can be used to respond to the keyboard input for Find (i.e. ctrl+F/cmd+F) to show all elements, which then
   *    allows the list items to be searchable
   *
   * @property renderAll
   * @type Boolean
   * @default false
   */
  get renderAll() {
    return this.args.renderAll ?? false;
  }

  /**
   * The tag name used in DOM elements before and after the rendered list. By default, it is set to
   * 'occluded-content' to avoid any confusion with user's CSS settings. However, it could be
   * overriden to provide custom behavior (for example, in table user wants to set it to 'tr' to
   * comply with table semantics).
   */
  occlusionTagName = 'occluded-content';

  get isEmpty() {
    return this.items?.length === 0;
  }

  get shouldYieldToInverse() {
    return this.isEmpty;
  }

  // @computed('items.[]', 'renderAll', 'estimateHeight', 'bufferSize')
  get virtualComponents() {
    const { _radar } = this;

    const items = this.items;

    _radar.items = items === null || items === undefined ? [] : items;
    _radar.estimateHeight = this.estimateHeight;
    _radar.renderAll = this.renderAll;
    _radar.bufferSize = this.bufferSize;

    _radar.scheduleUpdate(true);
    return _radar.virtualComponents;
  }

  schedule(queueName: string, job: unknown) {
    return scheduler.schedule(queueName, job, this.token);
  }

  _scheduleSendAction(action: string, index: number) {
    this._scheduledActions.push([action, index]);

    if (this._nextSendActions === null) {
      this._nextSendActions = window.setTimeout(() => {
        this._nextSendActions = null;

        run(() => {
          const items = this.items;
          const keyPath = this.key;

          this._scheduledActions.forEach(
            ([action, index]: [string, number]) => {
              const item = objectAt(items, index);
              const key = keyForItem(item, keyPath, index);

              // this.sendAction will be deprecated in ember 4.0
              const _action = this.args[action];
              if (typeof _action == 'function') {
                _action(item, index, key);
              }
            }
          );
          this._scheduledActions.length = 0;
        });
      });
    }
  }

  // –––––––––––––– Setup/Teardown
  @action didInsertMainContainer() {
    this.schedule('sync', () => {
      this._radar.start();
    });
  }

  @action willDestroyMainContainer() {
    this.token.cancel();
    this._radar.destroy();
    if (this._nextSendActions) {
      clearTimeout(this._nextSendActions);
    }
  }

  constructor(owner: unknown, args: IVerticalCollectionArgs) {
    super(owner, args);

    this.token = new Token();
    const RadarClass = this.staticHeight ? StaticRadar : DynamicRadar;

    const items = this.items || [];

    const bufferSize = this.bufferSize;
    const containerSelector = this.containerSelector;
    const estimateHeight = this.estimateHeight;
    const initialRenderCount = this.args.initialRenderCount;
    const renderAll = this.renderAll;
    const renderFromLast = this.renderFromLast;
    const shouldRecycle = this.shouldRecycle;
    const occlusionTagName = this.occlusionTagName;

    const idForFirstItem = this.idForFirstItem;
    const key = this.key;

    const startingIndex = calculateStartingIndex(
      items,
      idForFirstItem,
      key,
      renderFromLast
    );
    this._radar = new RadarClass(this.token, {
      bufferSize,
      containerSelector,
      estimateHeight,
      initialRenderCount,
      items,
      key,
      renderAll,
      renderFromLast,
      shouldRecycle,
      startingIndex,
      occlusionTagName,
    });
    this._prevItemsLength = 0;
    this._prevFirstKey = null;
    this._prevLastKey = null;

    this._hasAction = null;
    this._scheduledActions = [];
    this._nextSendActions = null;

    let a = !!this.args.lastReached;
    let b = !!this.args.firstReached;
    let c = !!this.args.lastVisibleChanged;
    let d = !!this.args.firstVisibleChanged;
    let any = a || b || c || d;

    if (any) {
      this._hasAction = {
        lastReached: a,
        firstReached: b,
        lastVisibleChanged: c,
        firstVisibleChanged: d,
      };

      this._radar.sendAction = (action: string, index: number) => {
        if (this._hasAction && this._hasAction[action]) {
          this._scheduleSendAction(action, index);
        }
      };
    }
  }
}

function calculateStartingIndex(items: Array<unknown>, idForFirstItem: string | null, key: string, renderFromLast: boolean) {
  const totalItems = items.length;

  let startingIndex = 0;

  if (idForFirstItem !== undefined && idForFirstItem !== null) {
    for (let i = 0; i < totalItems; i++) {
      if (keyForItem(objectAt(items, i), key, i) === idForFirstItem) {
        startingIndex = i;
        break;
      }
    }
  } else if (renderFromLast === true) {
    // If no id was set and `renderFromLast` is true, start from the bottom
    startingIndex = totalItems - 1;
  }

  return startingIndex;
}
