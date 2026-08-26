/**
 * replay maps validated session events to an injected browser adapter.
 */
export async function replay(session, adapter, options = {}) {
  if (!session?.events || typeof adapter?.move !== "function") throw new TypeError("replay requires session events and browser adapter");
  const speed = options.speed ?? 1;
  let previous = 0;
  let currentcontext = normalizecontext(options.initialcontext);
  let contextswitches = 0;
  for (const event of session.events) {
    const wait = Math.max(0, (event.t - previous) / speed);
    if (wait) await delay(wait);
    previous = event.t;
    const eventcontext = normalizecontext(event.context ?? event);
    if (eventcontext && contextchanged(currentcontext, eventcontext)) {
      await restorecontext(adapter, eventcontext, currentcontext);
      currentcontext = eventcontext;
      contextswitches += 1;
    }
    if (event.type === "move") await adapter.move(event);
    else if (event.type === "click") await adapter.click(event);
    else if (event.type === "drag") await adapter.drag(event);
    else if (event.type === "scroll") await adapter.scroll(event);
    else if (event.type === "key") await adapter.key(event);
  }
  return { events: session.events.length, duration: previous / speed, contextswitches };
}

function normalizecontext(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("replay context must be an object");
  const context = {};
  for (const name of ["windowid", "tabid", "frameid"]) if (value[name] !== undefined) {
    if (typeof value[name] !== "string" || !value[name]) throw new TypeError(`replay ${name} must be a non-empty string`);
    context[name] = value[name];
  }
  return Object.keys(context).length ? context : undefined;
}

function contextchanged(previous, next) {
  return ["windowid", "tabid", "frameid"].some((name) => previous?.[name] !== next[name]);
}

async function restorecontext(adapter, next, previous) {
  if (typeof adapter.restorecontext === "function") {
    await adapter.restorecontext({ ...next }, previous ? { ...previous } : undefined);
    return;
  }
  const methods = [["windowid", "selectwindow"], ["tabid", "selecttab"], ["frameid", "selectframe"]];
  for (const [name, method] of methods) if (next[name] !== undefined && previous?.[name] !== next[name]) {
    if (typeof adapter[method] !== "function") {
      const error = new Error(`replay adapter cannot restore ${name}`);
      error.code = "REPLAY_CONTEXT_UNSUPPORTED";
      error.context = name;
      throw error;
    }
    await adapter[method](next[name], { ...next });
  }
}

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
