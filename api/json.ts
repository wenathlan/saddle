/**
 * json helpers keep serialization rules explicit at the protocol boundary.
 */
export function jsonencode(value) { return JSON.stringify(value); }
export function jsondecode(value) { return JSON.parse(value); }
