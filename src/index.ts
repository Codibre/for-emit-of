import { EventEmitter } from "events";
import { Readable, Writable } from "stream";
import { timeout, TimeoutWrapper, timedOut } from "./timeout";
import { sleep } from "./sleep";

const defaults = {
  event: "data",
  error: "error",
  end: ["close", "end"],
};

/**
 * Options to define AsyncIterable behavior
 */
interface Options<T = any> {
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
}

type SuperEmitter = (EventEmitter | Readable | Writable) & {
  readableEnded?: boolean;
  writableEnded?: boolean;
};

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

function getTimeoutRace<T>(options: Options<T>, emitter: SuperEmitter) {
  let timeoutRace: () => Array<Promise<void | symbol>>;
  return () =>
    timeoutRace
      ? timeoutRace()
      : [
          getFirstAwaiter<T>(options, emitter).then((result) => {
            if (result !== timedOut) {
              timeoutRace = getInBetweenTimeoutRace(options, emitter);
            }
            return result;
          }),
        ];
}

function raceFactory<T>(options: Options<T>, emitter: SuperEmitter) {
  if (options.inBetweenTimeout) {
    return getTimeoutRace(options, emitter);
  }

  return () => [getFirstAwaiter<T>(options, emitter)];
}

function forEmitOf<T = any>(emitter: SuperEmitter): AsyncIterable<T>;
function forEmitOf<T = any>(
  emitter: SuperEmitter,
  options: Options<T>
): AsyncIterable<T>;

/**
 * @param {import('events').EventEmitter} emitter
 * @param {{event: string, transform: () => any}} options
 */
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
  emitter.on(options.event, eventListener);
  emitter.once(options.error, errorListener);
  options.end.forEach((event) => {
    emitter.once(event, endListener);
  });

  const getRaceItems = raceFactory<T>(options, emitter);

  async function* generator() {
    while (events.length || active) {
      if (error) {
        throw error;
      }
      while (events.length > 0) {
        /* We do not want to block the process!
            This call allows other processes
            a chance to execute.
        */
        await sleep(0);
        const [event, ...rest] = events;
        events = rest;

        yield options.transform ? options.transform(event) : event;
      }
      if (active && !error) {
        const winner = await Promise.race(getRaceItems());
        if (winner === timedOut) {
          emitter.removeListener(options.event, eventListener);
          emitter.removeListener(options.error, errorListener);
          options.end.forEach((event) =>
            emitter.removeListener(event, endListener)
          );
          throw Error("Event timed out");
        }
      }
    }
  }

  return generator();
}

export default forEmitOf;
