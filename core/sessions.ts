/**
 * session logs are versioned and validated before any replay adapter sees them.
 */
import { validationerror } from "../core/errors.js";

const eventtypes = new Set(["move", "click", "drag", "scroll", "key"]);

export function validatesession(value) {
  if (!value || typeof value !== "object") throw validationerror("session must be an object");
  if (value.version !== 1 || typeof value.id !== "string" || typeof value.agentname !== "string" || typeof value.originurl !== "string" || typeof value.seed !== "string") throw validationerror("session header is invalid");
  if (!Array.isArray(value.events)) throw validationerror("session events must be an array");
  if (!["created", "recording", "closed"].includes(value.status)) throw validationerror("session status is invalid");
  if (!Number.isFinite(value.startedat) || value.startedat < 0) throw validationerror("session startedat is invalid");
  return {
    version: 1,
    id: value.id,
    agentname: value.agentname,
    originurl: value.originurl,
    seed: value.seed,
    status: value.status,
    startedat: value.startedat,
    finishedat: Number.isFinite(value.finishedat) ? value.finishedat : undefined,
    events: value.events.map((event, index) => validateevent(event, index))
  };
}

function validateevent(value, index) {
  if (!value || typeof value !== "object" || !Number.isFinite(value.t) || value.t < 0 || !eventtypes.has(value.type)) throw validationerror(`session event ${index} is invalid`);
  for (const name of ["x", "y", "tx", "ty", "dx", "dy"]) if (value[name] !== undefined && !Number.isFinite(value[name])) throw validationerror(`session event ${index} ${name} is invalid`);
  if (value.key !== undefined && typeof value.key !== "string") throw validationerror(`session event ${index} key is invalid`);
  if (value.target !== undefined && typeof value.target !== "string") throw validationerror(`session event ${index} target is invalid`);
  if (value.button !== undefined && !["left", "right"].includes(value.button)) throw validationerror(`session event ${index} button is invalid`);
  const context = validatecontext(value.context ?? value, index);
  return context ? { ...value, context } : { ...value };
}

function validatecontext(value, index) {
  if (value.context !== undefined && (value.context === null || typeof value.context !== "object" || Array.isArray(value.context))) throw validationerror(`session event ${index} context is invalid`);
  const source = value.context ?? value;
  const context = {};
  for (const name of ["windowid", "tabid", "frameid"]) if (source[name] !== undefined) {
    if (typeof source[name] !== "string" || !source[name]) throw validationerror(`session event ${index} ${name} is invalid`);
    context[name] = source[name];
  }
  return Object.keys(context).length ? context : undefined;
}
