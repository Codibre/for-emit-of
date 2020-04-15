import { EventEmitter } from "events";
import { Readable, Writable } from "stream";
import * as util from "util";

const sleep = util.promisify(setTimeout);

const defaults = { event: "data", error: "error" };

interface Options<T = any> {
  event?: string;
  transform?: (buffer: Buffer) => T;
}

type SuperEmitter = (EventEmitter | Readable | Writable) & {
  readableEnded?: boolean;
  writableEnded?: boolean;
};

function main(emitter: SuperEmitter): AsyncIterable<any>;
function main(emitter: SuperEmitter, options: Options): AsyncIterable<any>;
function main<T>(emitter: SuperEmitter): AsyncIterable<T>;
function main<T>(emitter: SuperEmitter, options: Options<T>): AsyncIterable<T>;
function main<T>(emitter: SuperEmitter, options?: Options<T>) {
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

  emitter.on(options.event, (event) => events.push(event));

  emitter.once("error", (err) => {
    error = err;
  });

  ["close", "end"].forEach((event) => {
    emitter.once(event, () => {
      active = false;
    });
  });

  async function* forEmitOf() {
    while (events.length || active) {
      if (error) {
        throw error;
      }

      /* We do not want to block the process!
         This call allows other processes
         a chance to execute.
       */
      await sleep(0);

      const [event, ...rest] = events;

      events = rest;

      let result = event;

      if (options.transform) {
        result = await options.transform(event);
      }

      yield result;
    }
  }

  return forEmitOf();
}

export default main;
