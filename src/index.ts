import { EventEmitter } from "events";
import { Readable, Writable } from "stream";
import { sleep } from "./sleep";
import { timedOut, timeout, TimeoutWrapper } from "./timeout";
import {
  debugKeepAlive,
  debugYielding,
  debugYieldLimit,
  debugRaceStart,
  debugRaceEnd,
  debugKeepAliveEnding,
} from "./debugging";

const defaults = {
  event: "data",
  error: "error",
  end: ["close", "end"],
  keepAlive: 1000,
  debug: false,
};

/**
 * Options to define AsyncIterable behavior
 */
export interface Options<T = any> {
  /**
   * The event that generates the AsyncIterable items
   */
  event?: string;
  /**
   * The event to be listen for errors, default "error"
   */
  error?: string;
  /**
   * The events to be listen for finalization, default ["end", "close"]
   */
  end?: string[];
  /**
   * The timeout for the first event emission. If not informed, the AsyncIterable will wait indefinitely
   * for it. If it is informed and the timeout is reached, an error is thrown
   */
  firstEventTimeout?: number;
  /**
   * The timeout for between each event emission. If not informed, the AsyncIterable will wait indefinitely
   * for them. If it is informed and the timeout is reached, an error is thrown
   */
  inBetweenTimeout?: number;
  /**
   * A transformation to be used for each iterable element before yielding it. If not informed,
   * the value will be yield as is.
   */
  transform?: (buffer: Buffer) => T;
  /**
   * Max number of items to be yielded. If not informed, it'll yield all items of the iterable.
   */
  limit?: number;
  /**
   * The max interval, in milliseconds, of idleness for the iterable generated. For the iterable
   * to kept node process running, it need to have at least one task not based on event created,
   * this property defines the keepAlive time for such task. If timeout is used, this property is
   * ignored. Default: 1000
   */
  keepAlive?: number;
  /**
   * if some debug code lines will be printed. Useful to understand how for-emit-of are performing.
   * Default: false
   */
  debug?: boolean;
}

type SuperEmitter = (EventEmitter | Readable | Writable) & {
  readableEnded?: boolean;
  writableEnded?: boolean;
};

type TimeoutRaceFactory = () => Array<Promise<void | symbol>>;

function waitResponse<T = any>(emitter: SuperEmitter, options: Options<T>) {
  return new Promise<void>((resolve, reject) => {
    emitter.once(options.event, () => {
      resolve();
      emitter.removeListener(options.error, reject);
      options.end.forEach((event) => emitter.removeListener(event, resolve));
    });
    emitter.once(options.error, reject);
    options.end.forEach((event) => emitter.once(event, resolve));
  });
}

async function awaitAndResetTimeout<T>(
  emitter: SuperEmitter,
  options: Options<T>,
  timeoutWrapper: TimeoutWrapper
) {
  const result = await waitResponse(emitter, options);
  timeoutWrapper.updateDeadline();
  return result;
}

function getInBetweenTimeoutRace<T>(
  options: Options<T>,
  emitter: SuperEmitter
) {
  const timeoutWrapper = timeout(options.inBetweenTimeout);
  return () => [
    awaitAndResetTimeout<T>(emitter, options, timeoutWrapper),
    timeoutWrapper.awaiter,
  ];
}

function getFirstAwaiter<T>(options: Options<T>, emitter: SuperEmitter) {
  if (options.firstEventTimeout) {
    const firstTimeout = timeout(options.firstEventTimeout);
    return Promise.race([waitResponse(emitter, options), firstTimeout.awaiter]);
  }
  return waitResponse(emitter, options);
}

function switchRace<T>(
  options: Options<T>,
  emitter: SuperEmitter,
  getNextRace: () => TimeoutRaceFactory
) {
  let timeoutRace: TimeoutRaceFactory;
  return () =>
    timeoutRace
      ? timeoutRace()
      : [
          getFirstAwaiter<T>(options, emitter).then((result) => {
            if (result !== timedOut) {
              timeoutRace = getNextRace();
            }
            return result;
          }),
        ];
}

function getTimeoutRace<T>(options: Options<T>, emitter: SuperEmitter) {
  return switchRace<T>(options, emitter, () =>
    getInBetweenTimeoutRace(options, emitter)
  );
}

function raceFactory<T>(options: Options<T>, emitter: SuperEmitter) {
  if (options.inBetweenTimeout) {
    return getTimeoutRace(options, emitter);
  }

  const getWaitResponse = () => [waitResponse<T>(emitter, options)];
  return options.firstEventTimeout
    ? switchRace(options, emitter, () => getWaitResponse)
    : getWaitResponse;
}

function forEmitOf<T = any>(emitter: SuperEmitter): AsyncIterable<T>;
function forEmitOf<T = any>(
  emitter: SuperEmitter,
  options: Options<T>
): AsyncIterable<T>;

function forEmitOf<T = any>(emitter: SuperEmitter, options?: Options<T>) {
  if (!options) {
    options = defaults;
  }

  options = { ...defaults, ...options };

  if (!(emitter instanceof EventEmitter)) {
    throw new Error("emitter must be a instance of EventEmitter");
  }

  if (emitter.readableEnded || emitter.writableEnded) {
    throw new Error("stream has ended");
  }

  if (options.transform) {
    if (typeof options.transform !== "function") {
      throw new Error("transform must be a function");
    }
  }

  if (!Array.isArray(options.end)) {
    throw new Error("end must be an array");
  }

  let events = [];
  let error: Error;
  let active = true;

  const eventListener = <T>(event: T) => events.push(event);
  const endListener = () => {
    active = false;
  };
  const errorListener = (err: Error) => {
    error = err;
  };
  const removeListeners = () => {
    emitter.removeListener(options.event, eventListener);
    emitter.removeListener(options.error, errorListener);
    options.end.forEach((event) => emitter.removeListener(event, endListener));
  };

  emitter.on(options.event, eventListener);
  emitter.once(options.error, errorListener);
  options.end.forEach((event) => emitter.once(event, endListener));

  const getRaceItems = raceFactory<T>(options, emitter);

  async function* generator() {
    let shouldYield = true;
    let countEvents = 0;
    let countKeepAlive = 0;
    const start = process.hrtime();

    if (!options.firstEventTimeout || !options.inBetweenTimeout) {
      function keepAlive() {
        if (
          active &&
          !error &&
          (countEvents === 0 || !options.inBetweenTimeout)
        ) {
          countKeepAlive = debugKeepAlive(options, countKeepAlive, start);
          setTimeout(keepAlive, options.keepAlive);
        } else {
          debugKeepAliveEnding(options, countKeepAlive, start);
        }
      }
      setTimeout(keepAlive, options.keepAlive);
    }

    while (shouldYield && (events.length || active)) {
      if (error) {
        throw error;
      }

      while (shouldYield && events.length > 0) {
        debugYielding(options, events);
        /* We do not want to block the process!
            This call allows other processes
            a chance to execute.
        */
        await sleep(0);

        const [event, ...rest] = events;
        events = rest;

        yield options.transform ? options.transform(event) : event;

        countEvents++;

        if (options.limit && countEvents >= options.limit) {
          debugYieldLimit(options);
          shouldYield = false;
        }
      }

      if (active && !error) {
        debugRaceStart<T>(options);
        const winner = await Promise.race(getRaceItems());
        debugRaceEnd<T>(options, winner);

        if (winner === timedOut) {
          removeListeners();
          active = false;
          throw Error("Event timed out");
        }
      }
    }
    active = false;
    removeListeners();
  }

  return generator();
}

export default forEmitOf;
