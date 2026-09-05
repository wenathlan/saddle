/**
 * quantum.ts — classical quantum-simulation layer for e2ugh v18.
 *
 * the module is a 100 percent classical software statevector simulator:
 * no hardware, no photons, no qpu. the engine "supports" quantum the same
 * way it virtualizes cores, memory and gpus — as one more virtualization
 * layer: every "qubit" is a pair of float64 lanes inside a 2^n amplitude
 * vector (interleaved re/im), every "gate" is an in-place index-pair
 * transformation and every "measurement" is a crypto-seeded collapse of
 * that vector.
 *
 * contexts (22):
 *  01 version anchors (algorithm dates, simulator envelope)
 *  02 error catcher (quantumerror envelope)
 *  03 complex math kernel (2x2 unitary type + gate matrices)
 *  04 quantumsim statevector core (1-20 qubits, Disposable)
 *  05 multi-qubit gate kernels (cnot, cz, toffoli, swap, ccz)
 *  06 canonical circuits (bellstate, ghzstate)
 *  07 grover search (grover2 provable, grover3 statistical)
 *  08 deutsch oracle discrimination (deutsch)
 *  09 quantum teleportation sketch (qteleport)
 *  10 bb84 stations (alice, bob, eve over a simulated channel)
 *  11 bb84 protocol runner (runbb84: sifting, qber, intercept detection)
 *  12 e91 entangled pairs + chsh (rune91)
 *  13 qrng (quantuminspiredrandom, honest anu fallback)
 *  14 dnavault codec (goldman 2013 ternary rotation, framing, strands)
 *  15 dnavault decode (checksum verification, redundancy, roundtrip)
 *  16 dnavault capacity planner (215 pb/g, planodefault)
 *  17 optical 5d quartz planner (360 tb/disc, femtosecond write plan)
 *  18 holographic note (microsoft hsd) and storage compare
 *  19 qram bucket brigade (giovannetti 2008, o(log n) routing, n=8)
 *  20 shor plan (honest: theoretical 7-qubit circuit, never executed)
 *  21 registry (quantumregistry capability catalog)
 *  22 self check (quantumselfcheck: every claim, machine-verified)
 *
 * rules: lowercase identifiers, english jsdoc third person, no emoji,
 * try/catch catcher on every fallible path, node:* built-ins only
 * (node:crypto for all randomness), zero runtime dependencies, no
 * filesystem, network or process coupling beyond the optional,
 * always-fallback anu qrng fetch. ascii only.
 */

import { randomBytes, randomInt } from 'node:crypto';

/* ------------------------------------------------------------------ */
/* context: version anchors (quantum simulation envelope)               */
/* ------------------------------------------------------------------ */

/**
 * frozen quantum layer anchors. every algorithm keeps its literature
 * year so the registry can cite primary sources instead of folklore.
 */
export const quantumversions = {
  date: '2026-08-23',
  simulator: 'statevector',
  precision: 'float64 interleaved re/im',
  maxqubits: 20,
  amplitudelanes: 2097152,
  grover: '1996 stoc',
  deutschjozsa: '1992 proc r soc a',
  bb84: '1984 bangalore proceedings',
  e91: '1991 prl 67 661',
  teleportation: '1993 prl 70 1895',
  qram: '2008 prl 100 160501',
} as const satisfies Record<string, string | number>;

/* ------------------------------------------------------------------ */
/* context: error catcher                                               */
/* ------------------------------------------------------------------ */

/**
 * quantum layer failure envelope. every guard in this module throws it
 * instead of a bare error so callers can branch on the code.
 */
export class quantumerror extends Error {
  readonly code: string;
  readonly detail?: string;

  constructor(params: { code: string; message: string; detail?: string }) {
    super(params.message);
    this.name = 'quantumerror';
    this.code = params.code;
    this.detail = params.detail;
  }
}

/* ------------------------------------------------------------------ */
/* context: complex math kernel (2x2 unitaries)                         */
/* ------------------------------------------------------------------ */

/**
 * a 2x2 complex unitary with rows and columns interleaved as
 * [u00re, u00im, u01re, u01im, u10re, u10im, u11re, u11im].
 * gate matrices are plain float tuples so the hot loop stays monomorphic.
 */
export type gate2x2 = readonly [number, number, number, number, number, number, number, number];

const invsqrt2 = Math.SQRT1_2;

/** hadamard matrix ((1/sqrt 2) [[1,1],[1,1]]). */
export const hmatrix: gate2x2 = [invsqrt2, 0, invsqrt2, 0, invsqrt2, 0, invsqrt2, 0];

/** pauli x matrix [[0,1],[1,0]]. */
export const xmatrix: gate2x2 = [0, 0, 1, 0, 1, 0, 0, 0];

/** pauli y matrix [[0,-i],[i,0]]. */
export const ymatrix: gate2x2 = [0, 0, 0, -1, 0, 1, 0, 0];

/** pauli z matrix diag(1,-1). */
export const zmatrix: gate2x2 = [1, 0, 0, 0, 0, 0, -1, 0];

/** phase gate s = diag(1, i). */
export const smatrix: gate2x2 = [1, 0, 0, 0, 0, 0, 0, 1];

/** inverse phase gate sdg = diag(1, -i). */
export const sdgmatrix: gate2x2 = [1, 0, 0, 0, 0, 0, 0, -1];

/** t gate = diag(1, exp(i pi/4)). */
export const tmatrix: gate2x2 = [1, 0, 0, 0, 0, 0, invsqrt2, invsqrt2];

/** inverse t gate = diag(1, exp(-i pi/4)). */
export const tdgmatrix: gate2x2 = [1, 0, 0, 0, 0, 0, invsqrt2, -invsqrt2];

/**
 * builds the rotation-x matrix rx(theta) =
 * [[cos(t/2), -i sin(t/2)], [-i sin(t/2), cos(t/2)]].
 */
export function rxmatrix(theta: number): gate2x2 {
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  return [c, 0, 0, -s, 0, -s, c, 0];
}

/**
 * builds the rotation-y matrix ry(theta) =
 * [[cos(t/2), -sin(t/2)], [sin(t/2), cos(t/2)]]; ry(2a)|0> equals the
 * polarization state cos(a)|0> + sin(a)|1>, which the e91 context uses
 * to prepare and measure at arbitrary analyzer angles.
 */
export function rymatrix(theta: number): gate2x2 {
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  return [c, 0, -s, 0, s, 0, c, 0];
}

/**
 * builds the rotation-z matrix rz(theta) = diag(e^{-i t/2}, e^{i t/2}).
 */
export function rzmatrix(theta: number): gate2x2 {
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  return [c, -s, 0, 0, 0, 0, c, s];
}

/* ------------------------------------------------------------------ */
/* context: quantumsim statevector core (1-20 qubits, Disposable)       */
/* ------------------------------------------------------------------ */

/**
 * pure-software statevector simulator. the state is one Float64Array of
 * 2 * 2^n lanes holding interleaved real and imaginary parts; qubit q is
 * bit q of the basis index (qubit 0 is the least significant bit), so
 * for a single-qubit gate on qubit q the kernel iterates every index i
 * with bit q = 0, takes j = i | 2^q and replaces the pair by
 * u @ [amp(i), amp(j)] exactly as specified. the class is Disposable and
 * meant to be used with `using` so amplitude memory is logically freed
 * even though the gc owns it.
 */
export class quantumsim implements Disposable {
  #amp: Float64Array;
  readonly #n: number;
  #disposed = false;

  constructor(nqubits: number) {
    if (!Number.isInteger(nqubits) || nqubits < 1 || nqubits > 20) {
      throw new quantumerror({
        code: 'qubitrange',
        message: `quantumsim supports 1 to 20 qubits, got ${nqubits}`,
        detail: '2^n amplitudes with n > 20 exceed the float64 lane budget',
      });
    }
    this.#n = nqubits;
    this.#amp = new Float64Array(2 << nqubits);
    this.#amp[0] = 1;
  }

  /** number of qubits of the register. */
  get nqubits(): number {
    return this.#n;
  }

  /** hilbert space dimension 2^n. */
  get dim(): number {
    return 1 << this.#n;
  }

  /** true once Symbol.dispose released the state. */
  get disposed(): boolean {
    return this.#disposed;
  }

  #guardlive(): void {
    if (this.#disposed) {
      throw new quantumerror({
        code: 'disposed',
        message: 'quantumsim state was disposed; create a new register',
      });
    }
  }

  #guardqubit(q: number, gate: string): void {
    if (!Number.isInteger(q) || q < 0 || q >= this.#n) {
      throw new quantumerror({
        code: 'qubitrange',
        message: `gate ${gate} needs a qubit in [0, ${this.#n - 1}], got ${q}`,
      });
    }
  }

  /**
   * applies a 2x2 unitary to qubit q by visiting each amplitude pair
   * (i, i|2^q) once; this is the mathematical core every named
   * single-qubit gate forwards to.
   */
  #apply1(q: number, m: gate2x2, gate: string): this {
    this.#guardlive();
    this.#guardqubit(q, gate);
    const amp = this.#amp;
    const mask = 1 << q;
    const [u00re, u00im, u01re, u01im, u10re, u10im, u11re, u11im] = m;
    for (let i = 0; i < this.dim; i++) {
      if ((i & mask) !== 0) continue;
      const j = i | mask;
      const i2 = i << 1;
      const j2 = j << 1;
      const are = amp[i2];
      const aim = amp[i2 + 1];
      const bre = amp[j2];
      const bim = amp[j2 + 1];
      amp[i2] = u00re * are - u00im * aim + u01re * bre - u01im * bim;
      amp[i2 + 1] = u00re * aim + u00im * are + u01re * bim + u01im * bre;
      amp[j2] = u10re * are - u10im * aim + u11re * bre - u11im * bim;
      amp[j2 + 1] = u10re * aim + u10im * are + u11re * bim + u11im * bre;
    }
    return this;
  }

  /** hadamard on qubit q. */
  h(q: number): this {
    return this.#apply1(q, hmatrix, 'h');
  }

  /** pauli x (bit flip) on qubit q. */
  x(q: number): this {
    return this.#apply1(q, xmatrix, 'x');
  }

  /** pauli y on qubit q. */
  y(q: number): this {
    return this.#apply1(q, ymatrix, 'y');
  }

  /** pauli z (phase flip) on qubit q. */
  z(q: number): this {
    return this.#apply1(q, zmatrix, 'z');
  }

  /** phase gate s = sqrt(z) on qubit q. */
  s(q: number): this {
    return this.#apply1(q, smatrix, 's');
  }

  /** inverse phase gate on qubit q. */
  sdg(q: number): this {
    return this.#apply1(q, sdgmatrix, 'sdg');
  }

  /** t = pi/8 gate on qubit q. */
  t(q: number): this {
    return this.#apply1(q, tmatrix, 't');
  }

  /** inverse t gate on qubit q. */
  tdg(q: number): this {
    return this.#apply1(q, tdgmatrix, 'tdg');
  }

  /** rotation-x by theta radians on qubit q. */
  rx(theta: number, q: number): this {
    return this.#apply1(q, rxmatrix(theta), `rx(${theta})`);
  }

  /** rotation-y by theta radians on qubit q. */
  ry(theta: number, q: number): this {
    return this.#apply1(q, rymatrix(theta), `ry(${theta})`);
  }

  /** rotation-z by theta radians on qubit q. */
  rz(theta: number, q: number): this {
    return this.#apply1(q, rzmatrix(theta), `rz(${theta})`);
  }

  /**
   * cnot: for every index i with control bit 1 and target bit 0,
   * swaps amplitudes i and i|2^target; each pair is visited once.
   */
  cnot(control: number, target: number): this {
    this.#guardlive();
    this.#guardqubit(control, 'cnot');
    this.#guardqubit(target, 'cnot');
    if (control === target) {
      throw new quantumerror({
        code: 'qubitcollision',
        message: `cnot control and target are both qubit ${control}`,
      });
    }
    const amp = this.#amp;
    const maskc = 1 << control;
    const maskt = 1 << target;
    for (let i = 0; i < this.dim; i++) {
      if ((i & maskc) === 0 || (i & maskt) !== 0) continue;
      this.#swappair(amp, i, i | maskt);
    }
    return this;
  }

  /**
   * cz: flips the sign of every amplitude whose control and target
   * bits are both 1.
   */
  cz(control: number, target: number): this {
    this.#guardlive();
    this.#guardqubit(control, 'cz');
    this.#guardqubit(target, 'cz');
    if (control === target) {
      throw new quantumerror({
        code: 'qubitcollision',
        message: `cz control and target are both qubit ${control}`,
      });
    }
    const amp = this.#amp;
    const mask = (1 << control) | (1 << target);
    for (let i = 0; i < this.dim; i++) {
      if ((i & mask) !== mask) continue;
      const i2 = i << 1;
      amp[i2] = -amp[i2];
      amp[i2 + 1] = -amp[i2 + 1];
    }
    return this;
  }

  /**
   * toffoli (ccnot): swaps amplitude pairs only when both control bits
   * are 1 and the target bit is 0.
   */
  toffoli(control1: number, control2: number, target: number): this {
    this.#guardlive();
    this.#guardqubit(control1, 'toffoli');
    this.#guardqubit(control2, 'toffoli');
    this.#guardqubit(target, 'toffoli');
    if (control1 === target || control2 === target || control1 === control2) {
      throw new quantumerror({
        code: 'qubitcollision',
        message: `toffoli needs three distinct qubits, got ${control1}, ${control2}, ${target}`,
      });
    }
    const amp = this.#amp;
    const mask1 = 1 << control1;
    const mask2 = 1 << control2;
    const maskt = 1 << target;
    for (let i = 0; i < this.dim; i++) {
      if ((i & mask1) === 0 || (i & mask2) === 0 || (i & maskt) !== 0) continue;
      this.#swappair(amp, i, i | maskt);
    }
    return this;
  }

  /**
   * swap: exchanges qubits a and b by visiting each index pair once
   * (bit a = 0 with bit b = 1 maps to its complement bit a = 1, bit
   * b = 0), so no pair is touched twice.
   */
  swap(a: number, b: number): this {
    this.#guardlive();
    this.#guardqubit(a, 'swap');
    this.#guardqubit(b, 'swap');
    if (a === b) {
      throw new quantumerror({
        code: 'qubitcollision',
        message: `swap needs two distinct qubits, got ${a} twice`,
      });
    }
    const amp = this.#amp;
    const maska = 1 << a;
    const maskb = 1 << b;
    for (let i = 0; i < this.dim; i++) {
      if ((i & maska) !== 0 || (i & maskb) === 0) continue;
      this.#swappair(amp, i, (i | maska) & ~maskb);
    }
    return this;
  }

  /** swaps the two interleaved complex amplitudes at basis indexes. */
  #swappair(amp: Float64Array, i: number, j: number): void {
    const i2 = i << 1;
    const j2 = j << 1;
    const re = amp[i2];
    const im = amp[i2 + 1];
    amp[i2] = amp[j2];
    amp[i2 + 1] = amp[j2 + 1];
    amp[j2] = re;
    amp[j2 + 1] = im;
  }

  /**
   * measurement outcome sampler: draws one uniform from node:crypto
   * (randomInt over 2^30 buckets, finer than any probability gap this
   * module produces), compares it with the |1> branch probability and
   * returns the observed branch.
   */
  #sample(pone: number): 0 | 1 {
    const roll = randomInt(0, 0x40000000) / 0x40000000;
    return roll < pone ? 1 : 0;
  }

  /**
   * measures qubit q in the computational basis, collapsing the state.
   * returns the observed classical bit.
   */
  measure(q: number): 0 | 1 {
    this.#guardlive();
    this.#guardqubit(q, 'measure');
    const amp = this.#amp;
    const mask = 1 << q;
    let pone = 0;
    for (let i = 0; i < this.dim; i++) {
      if ((i & mask) === 0) continue;
      const i2 = i << 1;
      pone += amp[i2] * amp[i2] + amp[i2 + 1] * amp[i2 + 1];
    }
    const outcome = this.#sample(pone);
    const keep = outcome === 1 ? mask : 0;
    let mass = 0;
    for (let i = 0; i < this.dim; i++) {
      const i2 = i << 1;
      if ((i & mask) !== keep) {
        amp[i2] = 0;
        amp[i2 + 1] = 0;
      } else {
        mass += amp[i2] * amp[i2] + amp[i2 + 1] * amp[i2 + 1];
      }
    }
    if (mass <= 0) {
      throw new quantumerror({
        code: 'zerovector',
        message: `collapse of qubit ${q} hit a zero-mass branch`,
      });
    }
    const scale = 1 / Math.sqrt(mass);
    for (let i = 0; i < this.#amp.length; i++) {
      this.#amp[i] *= scale;
    }
    return outcome;
  }

  /**
   * measures the full register in the computational basis and returns
   * the observed basis index (qubit 0 in bit 0).
   */
  measureall(): number {
    this.#guardlive();
    const amp = this.#amp;
    const roll = randomInt(0, 0x40000000) / 0x40000000;
    let acc = 0;
    let pick = this.dim - 1;
    for (let i = 0; i < this.dim; i++) {
      const i2 = i << 1;
      acc += amp[i2] * amp[i2] + amp[i2 + 1] * amp[i2 + 1];
      if (roll < acc) {
        pick = i;
        break;
      }
    }
    amp.fill(0);
    amp[pick << 1] = 1;
    return pick;
  }

  /**
   * returns the [p0, p1] distribution of qubit q without collapsing;
   * p1 = sum of |amplitude|^2 over indices with bit q set.
   */
  probs(q: number): [number, number] {
    this.#guardlive();
    this.#guardqubit(q, 'probs');
    const amp = this.#amp;
    const mask = 1 << q;
    let pone = 0;
    for (let i = 0; i < this.dim; i++) {
      if ((i & mask) === 0) continue;
      const i2 = i << 1;
      pone += amp[i2] * amp[i2] + amp[i2 + 1] * amp[i2 + 1];
    }
    return [1 - pone, pone];
  }

  /**
   * returns the full |amplitude|^2 distribution over all 2^n basis
   * states as a fresh Float64Array (index order: qubit 0 in bit 0).
   */
  probabilities(): Float64Array {
    this.#guardlive();
    const amp = this.#amp;
    const out = new Float64Array(this.dim);
    for (let i = 0; i < this.dim; i++) {
      const i2 = i << 1;
      out[i] = amp[i2] * amp[i2] + amp[i2 + 1] * amp[i2 + 1];
    }
    return out;
  }

  /** returns the complex amplitude of one basis index as [re, im]. */
  amplitude(index: number): readonly [number, number] {
    this.#guardlive();
    if (!Number.isInteger(index) || index < 0 || index >= this.dim) {
      throw new quantumerror({
        code: 'indexrange',
        message: `amplitude index must be in [0, ${this.dim - 1}], got ${index}`,
      });
    }
    const i2 = index << 1;
    return [this.#amp[i2], this.#amp[i2 + 1]];
  }

  /** returns a detached readonly snapshot copy of the state lanes. */
  state(): Readonly<Float64Array> {
    this.#guardlive();
    return this.#amp.slice();
  }

  /** euclidean norm of the state vector (should stay within 1e-12 of 1). */
  norm(): number {
    this.#guardlive();
    let sum = 0;
    for (let i = 0; i < this.#amp.length; i++) {
      sum += this.#amp[i] * this.#amp[i];
    }
    return Math.sqrt(sum);
  }

  /** renormalizes the state to unit norm (fixes float drift). */
  normalize(): this {
    this.#guardlive();
    const n = this.norm();
    if (n <= 0) {
      throw new quantumerror({
        code: 'zerovector',
        message: 'cannot normalize a zero vector',
      });
    }
    for (let i = 0; i < this.#amp.length; i++) {
      this.#amp[i] /= n;
    }
    return this;
  }

  /** resets the register to |0...0>. */
  reset(): this {
    this.#guardlive();
    this.#amp.fill(0);
    this.#amp[0] = 1;
    return this;
  }

  /** releases the amplitude lanes; any further gate call throws. */
  [Symbol.dispose](): void {
    this.#amp = new Float64Array(0);
    this.#disposed = true;
  }
}

/* ------------------------------------------------------------------ */
/* context: multi-qubit gate kernels (module-level forms)               */
/* ------------------------------------------------------------------ */

/**
 * applies cnot(control, target) to sim; functional spelling of the
 * quantumsim method for composition outside the class.
 */
export function cnot(sim: quantumsim, control: number, target: number): quantumsim {
  return sim.cnot(control, target);
}

/**
 * applies cz(control, target) to sim; the grover oracle for two qubits
 * is exactly this gate on the |11> amplitude.
 */
export function cz(sim: quantumsim, control: number, target: number): quantumsim {
  return sim.cz(control, target);
}

/**
 * applies toffoli(control1, control2, target) to sim, the universal
 * reversible gate of toffoli 1980 as used in every compiled oracle.
 */
export function toffoli(
  sim: quantumsim,
  control1: number,
  control2: number,
  target: number,
): quantumsim {
  return sim.toffoli(control1, control2, target);
}

/**
 * applies swap(a, b) to sim.
 */
export function swap(sim: quantumsim, a: number, b: number): quantumsim {
  return sim.swap(a, b);
}

/**
 * ccz: three-qubit phase flip, composed as toffoli conjugated by
 * hadamard on the target; used as the grover oracle and diffuser core.
 */
export function ccz(
  sim: quantumsim,
  control1: number,
  control2: number,
  target: number,
): quantumsim {
  sim.h(target);
  sim.toffoli(control1, control2, target);
  sim.h(target);
  return sim;
}

/* ------------------------------------------------------------------ */
/* context: canonical circuits (bell, ghz)                              */
/* ------------------------------------------------------------------ */

/**
 * proof bundle for a canonical circuit: the ready simulator plus the
 * documented expected distribution so callers can assert outcomes.
 */
export type circuitproof = {
  readonly sim: quantumsim;
  readonly name: string;
  readonly expectedprobs: readonly number[];
  readonly reference: string;
  readonly note: string;
};

/**
 * builds the bell state (|00> + |11>)/sqrt(2) with h(0) then cnot(0,1);
 * measurement of either qubit is a perfect coin and both always agree.
 * expected distribution: [0.5, 0, 0.5, 0].
 * reference: einstein-podolsky-rosen 1935; bell 1964; chapter 1 of
 * nielsen and chuang, quantum computation and quantum information
 * (2000).
 */
export function bellstate(): circuitproof {
  const sim = new quantumsim(2);
  sim.h(0).cnot(0, 1);
  return {
    sim,
    name: 'bell',
    expectedprobs: [0.5, 0, 0.5, 0],
    reference: 'bell 1964; nielsen and chuang 2000 ch. 1',
    note: 'maximally entangled pair; probs(0) = probs(1) = [0.5, 0.5]',
  };
}

/**
 * builds an n-qubit ghz state (|0...0> + |1...1>)/sqrt(2) by h(0) plus
 * a cnot fanout; expected distribution carries mass 0.5 on index 0 and
 * index 2^n - 1 only. reference: greenberger-horne-zeilinger 1989.
 */
export function ghzstate(n: number = 3): circuitproof {
  if (!Number.isInteger(n) || n < 2 || n > 12) {
    throw new quantumerror({
      code: 'qubitrange',
      message: `ghzstate supports 2 to 12 qubits, got ${n}`,
      detail: 'cap exists so expectedprobs stays readable',
    });
  }
  const sim = new quantumsim(n);
  sim.h(0);
  for (let q = 1; q < n; q++) {
    sim.cnot(0, q);
  }
  const expected = new Array<number>(1 << n).fill(0);
  expected[0] = 0.5;
  expected[(1 << n) - 1] = 0.5;
  return {
    sim,
    name: `ghz${n}`,
    expectedprobs: expected,
    reference: 'greenberger, horne, zeilinger 1989',
    note: 'n-party entanglement witness; only |0...0> and |1...1> survive',
  };
}

/* ------------------------------------------------------------------ */
/* context: grover search (grover2 provable, grover3 statistical)       */
/* ------------------------------------------------------------------ */

/**
 * grover2: exhaustive-search winner |11> on 2 qubits with exactly one
 * oracle call. the circuit is the task-pinned sequence
 * h,h -> cz -> h,h -> x,x -> cz -> h,h whose unique fixed point is
 * amplitude -1 on |11>, so prob(11) = 1 up to 1e-12 float noise.
 * expected distribution: [0, 0, 0, 1].
 * reference: grover, a fast quantum mechanical algorithm for database
 * search, stoc 1996 (arxiv:quant-ph/9605043).
 */
export function grover2(): circuitproof {
  const sim = new quantumsim(2);
  sim.h(0).h(1);
  sim.cz(0, 1);
  sim.h(0).h(1);
  sim.x(0).x(1);
  sim.cz(0, 1);
  sim.h(0).h(1);
  return {
    sim,
    name: 'grover2',
    expectedprobs: [0, 0, 0, 1],
    reference: 'grover 1996 stoc (arxiv:quant-ph/9605043)',
    note: 'one oracle call finds |11> with certainty (4 states, 1 marked)',
  };
}

/**
 * grover3: search over 8 items for winner |111> with two iterations of
 * oracle ccz + diffuser (h x3, x x3, ccz, x x3, h x3). theory gives
 * success sin^2(5 * asin(1/sqrt 8)) = 0.9461, comfortably above 0.9.
 * reference: grover 1996; boyer, brassard, hoefer, tapp 1998 iteration
 * counting for m = 1 marked item of n = 8.
 */
export function grover3(): circuitproof {
  const sim = new quantumsim(3);
  sim.h(0).h(1).h(2);
  for (let iteration = 0; iteration < 2; iteration++) {
    ccz(sim, 0, 1, 2);
    sim.h(0).h(1).h(2);
    sim.x(0).x(1).x(2);
    ccz(sim, 0, 1, 2);
    sim.x(0).x(1).x(2);
    sim.h(0).h(1).h(2);
  }
  const dim = sim.dim;
  const expected = new Array<number>(dim).fill(0.0077);
  expected[dim - 1] = 0.9461;
  return {
    sim,
    name: 'grover3',
    expectedprobs: expected,
    reference: 'grover 1996; boyer-brassard-hoefer-tapp 1998',
    note: 'prob(111) = 0.9461 theoretical; measured within float noise',
  };
}

/* ------------------------------------------------------------------ */
/* context: deutsch oracle discrimination                               */
/* ------------------------------------------------------------------ */

/**
 * deutsch verdict of the single-bit oracle f: 'constant' when f(0) =
 * f(1), 'balanced' when f(0) != f(1); one oracle call decides it.
 */
export type deutschverdict = 'constant' | 'balanced';

/**
 * deutsch algorithm on 2 qubits (input qubit 0, ancilla qubit 1 in
 * |->). the oracle is built from the truth table of f exactly as the
 * four possible (x, y) -> (x, y xor f(x)) unitaries: identity, x on
 * the ancilla, cnot(0,1) for f(x) = x, and x + cnot for f(x) = not x.
 * phase kickback leaves qubit 0 in |0> for constant f and |1> for
 * balanced f, so a single measurement decides the promise problem.
 * reference: deutsch 1985; deutsch and jozsa, rapid solution of
 * problems by quantum computation, proc r soc lond a 439, 553 (1992).
 */
export function deutsch(f: (x: 0 | 1) => 0 | 1): {
  sim: quantumsim;
  verdict: deutschverdict;
  measured: 0 | 1;
  expected: deutschverdict;
  reference: string;
} {
  const f0 = f(0);
  const f1 = f(1);
  const sim = new quantumsim(2);
  sim.x(1);
  sim.h(0).h(1);
  if (f0 === 0 && f1 === 0) {
    // constant zero: identity oracle, no gates.
  } else if (f0 === 1 && f1 === 1) {
    sim.x(1);
  } else if (f0 === 0 && f1 === 1) {
    sim.cnot(0, 1);
  } else {
    sim.x(1);
    sim.cnot(0, 1);
  }
  sim.h(0);
  const measured = sim.measure(0);
  return {
    sim,
    verdict: measured === 0 ? 'constant' : 'balanced',
    measured,
    expected: f0 === f1 ? 'constant' : 'balanced',
    reference: 'deutsch 1985; deutsch-jozsa 1992 proc r soc a 439 553',
  };
}

/* ------------------------------------------------------------------ */
/* context: quantum teleportation sketch                                */
/* ------------------------------------------------------------------ */

/**
 * qteleport: teleports the state of qubit 0 to qubit 2 through a bell
 * pair on qubits 1 and 2 (h(1), cnot(1,2)), the bell-basis measurement
 * cnot(0,1) + h(0), then the classical corrections x/z on qubit 2
 * conditioned on the two outcomes. the simulator runs the whole loop so
 * the fidelity is exactly 1 for any of the three prepared inputs; the
 * fidelity is read off the two amplitudes that survive the bell
 * measurement (index m1*2 + m0 and its +4 partner on qubit 2).
 * reference: bennett, brassard, crepeau, jozsa, peres, wootters,
 * teleporting an unknown quantum state via dual classical and
 * einstein-podolsky-rosen channels, prl 70, 1895 (1993).
 */
export function qteleport(input: 'zero' | 'one' | 'plus' = 'one'): {
  sim: quantumsim;
  outcome0: 0 | 1;
  outcome1: 0 | 1;
  fidelity: number;
  input: 'zero' | 'one' | 'plus';
  reference: string;
} {
  const sim = new quantumsim(3);
  if (input === 'one') {
    sim.x(0);
  } else if (input === 'plus') {
    sim.h(0);
  }
  sim.h(1);
  sim.cnot(1, 2);
  sim.cnot(0, 1);
  sim.h(0);
  const outcome1 = sim.measure(1);
  const outcome0 = sim.measure(0);
  if (outcome1 === 1) {
    sim.x(2);
  }
  if (outcome0 === 1) {
    sim.z(2);
  }
  const lowindex = (outcome1 << 1) | outcome0;
  const alow = sim.amplitude(lowindex);
  const ahigh = sim.amplitude(lowindex + 4);
  const fidelity =
    input === 'plus'
      ? ((alow[0] + ahigh[0]) / Math.SQRT2) ** 2 + ((alow[1] + ahigh[1]) / Math.SQRT2) ** 2
      : input === 'one'
        ? ahigh[0] * ahigh[0] + ahigh[1] * ahigh[1]
        : alow[0] * alow[0] + alow[1] * alow[1];
  return {
    sim,
    outcome0,
    outcome1,
    fidelity,
    input,
    reference: 'bennett, brassard, crepeau, jozsa, peres, wootters 1993 prl 70 1895',
  };
}

/* ------------------------------------------------------------------ */
/* context: bb84 stations (alice, bob, eve over a simulated channel)    */
/* ------------------------------------------------------------------ */

/**
 * basis 0 is rectilinear (z, states |0>/|1>) and basis 1 is diagonal
 * (x, states |+>/|->); the mapping matches the polarization bases of
 * the 1984 protocol.
 */
export type bb84basis = 0 | 1;

/**
 * alice station: draws random key bits and random bases from
 * node:crypto and prepares one 1-qubit quantumsim photon per bit
 * (x for bit 1, extra h when the basis is diagonal).
 */
export class alice {
  readonly #bits: number[] = [];
  readonly #bases: number[] = [];

  constructor(count: number) {
    try {
      for (let i = 0; i < count; i++) {
        this.#bits.push(randomInt(0, 2));
        this.#bases.push(randomInt(0, 2));
      }
    } catch (cause) {
      throw new quantumerror({
        code: 'randomness',
        message: 'alice could not draw randomness from node:crypto',
        detail: String(cause),
      });
    }
  }

  /** alice's raw key bits. */
  get bits(): readonly number[] {
    return this.#bits;
  }

  /** alice's basis string (0 rectilinear, 1 diagonal). */
  get bases(): readonly number[] {
    return this.#bases;
  }

  /**
   * prepares the photon burst; each photon is a real 1-qubit state so
   * the channel, eve and bob all act on amplitudes, not on labels.
   */
  prepare(): quantumsim[] {
    return this.#bits.map((bit, i) => {
      const photon = new quantumsim(1);
      if (bit === 1) {
        photon.x(0);
      }
      if (this.#bases[i] === 1) {
        photon.h(0);
      }
      return photon;
    });
  }
}

/**
 * bob station: measures each incoming photon in his own random bases
 * (h before the z measurement when diagonal), collapsing the photon.
 */
export class bob {
  readonly #bases: number[] = [];
  readonly #outcomes: number[] = [];

  constructor(count: number) {
    try {
      for (let i = 0; i < count; i++) {
        this.#bases.push(randomInt(0, 2));
      }
    } catch (cause) {
      throw new quantumerror({
        code: 'randomness',
        message: 'bob could not draw randomness from node:crypto',
        detail: String(cause),
      });
    }
  }

  /** bob's basis string. */
  get bases(): readonly number[] {
    return this.#bases;
  }

  /** bob's raw measurement outcomes. */
  get outcomes(): readonly number[] {
    return this.#outcomes;
  }

  /**
   * measures the whole burst and stores the classical outcomes;
   * measuring a diagonal-basis photon in the rectilinear basis
   * genuinely yields a coin flip, which is where intercept-resend
   * damage shows up.
   */
  measure(photons: readonly quantumsim[]): readonly number[] {
    this.#outcomes.length = 0;
    for (let i = 0; i < photons.length; i++) {
      const photon = photons[i];
      if (this.#bases[i] === 1) {
        photon.h(0);
      }
      this.#outcomes.push(photon.measure(0));
    }
    return this.#outcomes;
  }
}

/**
 * eve station: intercept-resend attacker. she measures every photon in
 * her own random basis (collapsing it) and resends a fresh photon
 * prepared in that basis with the bit she saw. on sifted bits where
 * alice and bob used the same basis, eve chose the wrong basis half
 * the time and bob then errs half of those, so the qber lands at 25
 * percent against 0 percent on a clean channel.
 * reference: the intercept-resend attack is exercise material of every
 * bb84 treatment since bennett-brassard 1984.
 */
export class eve {
  readonly #bases: number[] = [];
  readonly #bits: number[] = [];

  /** bases eve used (for audits). */
  get bases(): readonly number[] {
    return this.#bases;
  }

  /** bits eve extracted (for audits). */
  get bits(): readonly number[] {
    return this.#bits;
  }

  /** taps the burst and returns the resent photons. */
  intercept(photons: readonly quantumsim[]): quantumsim[] {
    this.#bases.length = 0;
    this.#bits.length = 0;
    return photons.map((photon) => {
      const basis = randomInt(0, 2);
      if (basis === 1) {
        photon.h(0);
      }
      const bit = photon.measure(0);
      const resend = new quantumsim(1);
      if (bit === 1) {
        resend.x(0);
      }
      if (basis === 1) {
        resend.h(0);
      }
      this.#bases.push(basis);
      this.#bits.push(bit);
      return resend;
    });
  }
}

/**
 * bb84 quantum channel: a photon pipeline that alice fills, an optional
 * eve taps (counted), and bob drains. no network, no localhost — the
 * channel is an in-memory queue standing in for fiber.
 */
export class bb84channel {
  #inflight: quantumsim[] = [];
  #taps = 0;

  /** sends a photon burst onto the channel. */
  send(photons: readonly quantumsim[]): void {
    this.#inflight = [...photons];
  }

  /**
   * taps the channel: the operator receives the in-flight burst and its
   * return value replaces it (intercept-resend); taps are counted.
   */
  tap(operator: (photons: readonly quantumsim[]) => quantumsim[]): quantumsim[] {
    this.#taps += 1;
    this.#inflight = operator(this.#inflight);
    return this.#inflight;
  }

  /** drains the channel for the receiver. */
  receive(): quantumsim[] {
    const out = this.#inflight;
    this.#inflight = [];
    return out;
  }

  /** number of taps observed on the channel (informational). */
  get tapped(): number {
    return this.#taps;
  }
}

/* ------------------------------------------------------------------ */
/* context: bb84 protocol runner (sifting, qber, detection)             */
/* ------------------------------------------------------------------ */

/**
 * runbb84 result: the sifted keys (sample bits removed), the
 * full-channel qber, and the sampling-based eavesdropper verdict.
 */
export type bb84result = {
  readonly keyalice: readonly number[];
  readonly keybob: readonly number[];
  readonly qber: number;
  readonly detected: boolean;
  readonly siftedlen: number;
  readonly sampledlen: number;
  readonly sampledqber: number;
  readonly threshold: number;
  readonly reference: string;
};

/**
 * runs the complete bb84 flow over the simulated channel: alice
 * prepares, the optional eve taps, bob measures, both sides sift on
 * equal bases, the qber is computed over the full sifted key and the
 * detection verdict comes from comparing a public sample of up to 128
 * sifted bits (abort threshold 11 percent, the one-way bb84
 * reconciliation bound of the shor-preskill lineage).
 * reference: bennett and brassard, quantum cryptography: public key
 * distribution and coin tossing, proc ieee int conf on computers,
 * systems and signal processing, bangalore 1984, pp. 175-179.
 */
export function runbb84(options: { eve?: boolean; bits?: number } = {}): bb84result {
  const bits = options.bits ?? 1024;
  if (!Number.isInteger(bits) || bits < 64 || bits > 8192) {
    throw new quantumerror({
      code: 'bitcount',
      message: `bb84 burst size must be in [64, 8192], got ${bits}`,
      detail: '1024 keeps the qber estimate comfortably outside noise bands',
    });
  }
  const a = new alice(bits);
  const b = new bob(bits);
  const channel = new bb84channel();
  channel.send(a.prepare());
  if (options.eve === true) {
    const attacker = new eve();
    channel.tap((photons) => attacker.intercept(photons));
  }
  b.measure(channel.receive());
  const sifted: number[] = [];
  for (let i = 0; i < bits; i++) {
    if (a.bases[i] === b.bases[i]) {
      sifted.push(i);
    }
  }
  if (sifted.length < 16) {
    throw new quantumerror({
      code: 'siftempty',
      message: 'sifting kept fewer than 16 bits; raise the burst size',
    });
  }
  let mismatches = 0;
  for (const i of sifted) {
    if (a.bits[i] !== b.outcomes[i]) {
      mismatches += 1;
    }
  }
  const qber = mismatches / sifted.length;
  const order = [...sifted.keys()];
  for (let i = order.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  const samplecount = Math.min(128, Math.max(8, Math.floor(sifted.length / 2)));
  const sample = new Set(order.slice(0, samplecount));
  let samplemismatch = 0;
  for (const i of sample) {
    if (a.bits[i] !== b.outcomes[i]) {
      samplemismatch += 1;
    }
  }
  const sampledqber = samplemismatch / sample.size;
  const keyalice: number[] = [];
  const keybob: number[] = [];
  for (const i of sifted) {
    if (sample.has(i)) continue;
    keyalice.push(a.bits[i]);
    keybob.push(b.outcomes[i]);
  }
  return {
    keyalice,
    keybob,
    qber,
    detected: sampledqber > 0.11,
    siftedlen: sifted.length,
    sampledlen: sample.size,
    sampledqber,
    threshold: 0.11,
    reference: 'bb84, bangalore 1984; abort threshold from shor-preskill 2000 lineage',
  };
}

/* ------------------------------------------------------------------ */
/* context: e91 entangled pairs + chsh                                  */
/* ------------------------------------------------------------------ */

/**
 * e91 run result: the chsh s value, the key bits extracted from
 * matched analyzer settings and the eavesdropper verdict.
 */
export type e91result = {
  readonly s: number;
  readonly classicalbound: number;
  readonly quantumbound: number;
  readonly detected: boolean;
  readonly keylen: number;
  readonly qber: number;
  readonly pairs: number;
  readonly chshpairs: number;
  readonly reference: string;
};

const deg2rad = Math.PI / 180;

/**
 * measures qubit q of sim at analyzer angle a (degrees): applies
 * ry(-2a) so outcome 0 projects onto cos(a)|0> + sin(a)|1> and outcome
 * 1 onto its orthogonal partner, then collapses via measure.
 */
function measureatangle(sim: quantumsim, q: number, angledeg: number): 0 | 1 {
  sim.ry(-2 * angledeg * deg2rad, q);
  return sim.measure(q);
}

/**
 * prepares a fresh |+a> = cos(a)|0> + sin(a)|1> photon on qubit q;
 * used by eve to resend exactly what she measured.
 */
function prepareangle(sim: quantumsim, q: number, angledeg: number, bit: 0 | 1): void {
  if (bit === 1) {
    sim.x(q);
  }
  if (angledeg !== 0) {
    sim.ry(2 * angledeg * deg2rad, q);
  }
}

/**
 * rune91: ekert-1991 entanglement-based key distribution on |phi+>
 * pairs. each round is half the time a key round (both parties pick
 * 0 or 45 degrees; equal angles give perfectly correlated bits on a
 * clean source) and half the time a chsh round (alice 0 or 45 degrees,
 * bob 22.5 or 67.5 degrees). the chsh statistic
 * s = e(0,22.5) - e(0,67.5) + e(45,22.5) + e(45,67.5) converges to
 * 2 sqrt(2) = 2.8284 for the entangled source and cannot exceed the
 * classical bound 2 once eve collapses the pairs, which is exactly the
 * e91 security test (bell-inequality violation as the eavesdropper
 * detector). an intercept-resend eve also pushes the matched-angle key
 * qber to 25 percent.
 * reference: ekert, quantum cryptography based on bell's theorem,
 * prl 67, 661 (1991); clauser-horne-shimony-holt 1969 prl 23 880;
 * bell 1964; aspect, dalibard, roger 1982.
 */
export function rune91(options: { eve?: boolean; pairs?: number } = {}): e91result {
  const pairs = options.pairs ?? 2400;
  if (!Number.isInteger(pairs) || pairs < 200 || pairs > 200000) {
    throw new quantumerror({
      code: 'paircount',
      message: `e91 needs 200 to 200000 pairs, got ${pairs}`,
      detail: '2400 pairs put the chsh noise band about three sigma from the verdict line',
    });
  }
  const keytotals = { matched: 0, mismatch: 0 };
  const buckets = new Map<string, { n: number; agree: number }>();
  for (let round = 0; round < pairs; round++) {
    let pair = new quantumsim(2);
    pair.h(0).cnot(0, 1);
    if (options.eve === true) {
      const b0 = randomInt(0, 2) === 1 ? 45 : 0;
      const b1 = randomInt(0, 2) === 1 ? 45 : 0;
      const m0 = measureatangle(pair, 0, b0);
      const m1 = measureatangle(pair, 1, b1);
      const resend = new quantumsim(2);
      prepareangle(resend, 0, b0, m0);
      prepareangle(resend, 1, b1, m1);
      pair = resend;
    }
    const mode = randomInt(0, 2);
    if (mode === 0) {
      const adeg = randomInt(0, 2) === 1 ? 45 : 0;
      const bdeg = randomInt(0, 2) === 1 ? 45 : 0;
      const ma = measureatangle(pair, 0, adeg);
      const mb = measureatangle(pair, 1, bdeg);
      if (adeg === bdeg) {
        keytotals.matched += 1;
        if (ma !== mb) {
          keytotals.mismatch += 1;
        }
      }
    } else {
      const adeg = randomInt(0, 2) === 1 ? 45 : 0;
      const bdeg = randomInt(0, 2) === 1 ? 67.5 : 22.5;
      const ea = measureatangle(pair, 0, adeg);
      const eb = measureatangle(pair, 1, bdeg);
      const keyname = `${adeg}:${bdeg}`;
      const bucket = buckets.get(keyname) ?? { n: 0, agree: 0 };
      bucket.n += 1;
      if (ea === eb) {
        bucket.agree += 1;
      }
      buckets.set(keyname, bucket);
    }
  }
  const correlation = (a: number, b: number): number => {
    const bucket = buckets.get(`${a}:${b}`);
    if (!bucket || bucket.n === 0) {
      return Number.NaN;
    }
    return (2 * bucket.agree) / bucket.n - 1;
  };
  const s =
    correlation(0, 22.5) - correlation(0, 67.5) + correlation(45, 22.5) + correlation(45, 67.5);
  if (!Number.isFinite(s)) {
    throw new quantumerror({
      code: 'chshsample',
      message: 'a chsh angle pair received zero samples; raise the pair count',
    });
  }
  const keylen = keytotals.matched;
  const qber = keylen === 0 ? Number.NaN : keytotals.mismatch / keylen;
  let chshpairs = 0;
  for (const bucket of buckets.values()) {
    chshpairs += bucket.n;
  }
  const detected = s <= 2.4 || (Number.isFinite(qber) && qber > 0.05);
  return {
    s,
    classicalbound: 2,
    quantumbound: 2 * Math.SQRT2,
    detected,
    keylen,
    qber,
    pairs,
    chshpairs,
    reference: 'ekert 1991 prl 67 661; chsh 1969; bell 1964; aspect 1982',
  };
}

/* ------------------------------------------------------------------ */
/* context: qrng (quantum-inspired random, honest anu fallback)         */
/* ------------------------------------------------------------------ */

/**
 * quantuminspiredrandom: draws count integers in [min, max) from the
 * node crypto CSPRNG via randomInt (node rejection-samples internally,
 * so the stream is unbiased). this is a classical CSPRNG standing in
 * for a QRNG photon source; the API shape matches hardware QRNG
 * services (count + integer range in, uniform integers out) so the
 * integration seam is already quantum-ready. no physics is claimed.
 */
export function quantuminspiredrandom(
  count: number,
  options: { min?: number; max?: number } = {},
): number[] {
  if (!Number.isInteger(count) || count < 1 || count > 1048576) {
    throw new quantumerror({
      code: 'countrange',
      message: `qrng count must be in [1, 1048576], got ${count}`,
    });
  }
  const min = options.min ?? 0;
  const max = options.max ?? 256;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min >= max || max - min > 2 ** 36) {
    throw new quantumerror({
      code: 'range',
      message: `qrng range needs integers min < max with span <= 2^36, got [${min}, ${max})`,
    });
  }
  try {
    const values: number[] = [];
    for (let i = 0; i < count; i++) {
      values.push(randomInt(min, max));
    }
    return values;
  } catch (cause) {
    throw new quantumerror({
      code: 'randomness',
      message: 'crypto.randomInt failed while filling the qrng batch',
      detail: String(cause),
    });
  }
}

/**
 * anuqrng: optional asynchronous fetch of the australian national
 * university quantum random numbers service (api.quantumnumbers.io,
 * successor of qrng.anu.edu.au), which digitizes vacuum fluctuations.
 * the planner is honest: without network egress or an api key the call
 * fails fast (abort timeout 2500 ms default) and the function falls
 * back to the same CSPRNG as quantuminspiredrandom, reporting
 * source: 'csprng'. anu values are 64-bit unsigned integers folded
 * into the requested range with one modulo (bias below 2^-32 for any
 * practical span, documented here rather than hidden).
 */
export async function anuqrng(
  count: number,
  options: { apikey?: string; timeoutms?: number; min?: number; max?: number } = {},
): Promise<{ values: number[]; source: 'anu' | 'csprng'; note: string }> {
  const min = options.min ?? 0;
  const max = options.max ?? 256;
  const span = max - min;
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 1024 ||
    !Number.isInteger(min) ||
    min >= max
  ) {
    throw new quantumerror({
      code: 'range',
      message: `anuqrng needs count in [1, 1024] and integer min < max, got count=${count}`,
    });
  }
  const timeoutms = options.timeoutms ?? 2500;
  const apikey = options.apikey ?? '';
  try {
    const url =
      `https://api.quantumnumbers.io/qranum/v1/generate?apikey=${apikey}` +
      `&number=${count}&size=8`;
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutms) });
    if (!response.ok) {
      throw new Error(`anu http status ${response.status}`);
    }
    const payload = (await response.json()) as { data?: unknown };
    if (!Array.isArray(payload.data) || payload.data.length < count) {
      throw new Error('anu payload did not carry enough values');
    }
    const values = payload.data.slice(0, count).map((value) => min + (Number(value) % span));
    if (values.some((value) => !Number.isInteger(value) || value < min || value >= max)) {
      throw new Error('anu payload contained non-integer entries');
    }
    return {
      values,
      source: 'anu',
      note: 'vacuum-fluctuation source, api.quantumnumbers.io',
    };
  } catch (cause) {
    return {
      values: quantuminspiredrandom(count, { min, max }),
      source: 'csprng',
      note: `anu fetch unavailable (${String(cause)}); honest CSPRNG fallback`,
    };
  }
}

/**
 * convenience bytes draw used by the self check and available to
 * integrators: crypto.randomBytes surfaced under the qrng banner with
 * the same honesty note as quantuminspiredrandom.
 */
export function quantuminspiredbytes(count: number): Uint8Array {
  if (!Number.isInteger(count) || count < 1 || count > 1048576) {
    throw new quantumerror({
      code: 'countrange',
      message: `qrng byte count must be in [1, 1048576], got ${count}`,
    });
  }
  try {
    return randomBytes(count);
  } catch (cause) {
    throw new quantumerror({
      code: 'randomness',
      message: 'crypto.randomBytes failed',
      detail: String(cause),
    });
  }
}

/* ------------------------------------------------------------------ */
/* context: dnavault codec (goldman 2013 ternary rotation)              */
/* ------------------------------------------------------------------ */

/**
 * dnavault codec constants: 4 strands addressed by blockindex mod 4,
 * each block synthesized twice (on its home strand and the next one)
 * so decoding survives the loss of any single strand; every byte maps
 * to 6 ternary digits (3^6 = 729 > 256) and every digit to one
 * nucleotide through the goldman rotation next = (digit + 1 + previous)
 * mod 4, which makes consecutive repeats impossible (homopolymer run
 * length 1, stricter than the standard run-length <= 3 synthesis
 * constraint). reference: goldman et al., towards practical,
 * high-capacity, low-maintenance information storage in synthesized
 * dna, nature 494, 77-80 (2013), doi:10.1038/nature11875.
 */
export const dnavaultspec = {
  strandcount: 4,
  redundancy: 2,
  blockpayloadbytes: 32,
  blockframebytes: 35,
  nucleotidesperblock: 210,
  tritsperbyte: 6,
  maxinputbytes: 65536,
  homopolymerrunmax: 1,
  rule: 'next = (digit + 1 + previous) mod 4, digit in {0,1,2}',
  reference: 'goldman et al. 2013 nature 494 77-80 doi:10.1038/nature11875',
} as const satisfies Record<string, string | number>;

const nucleotides = ['A', 'C', 'G', 'T'] as const;
const nucleotideindex: Readonly<Record<string, number>> = { A: 0, C: 1, G: 2, T: 3 };
const powersof3 = [1, 3, 9, 27, 81, 243];

/**
 * dnavaultencode result: the four strand oligo strings, the block
 * count and the nucleotide accounting for the capacity planner.
 */
export type dnavaultencoderesult = {
  readonly strands: readonly string[];
  readonly blocks: number;
  readonly oligos: number;
  readonly nucleotides: number;
  readonly redundancy: number;
  readonly homopolymerrunmax: number;
  readonly reference: string;
};

/**
 * encodes bytes into four dna strands with real goldman-2013 rules:
 * a 4-byte big-endian length prefix, 32-byte payload blocks framed as
 * [index u16 be][payload 32][checksum u8 of index + payload], ternary
 * rotation encoding per byte, dual-strand placement (blockindex mod 4
 * and (blockindex + 1) mod 4). the archive planner guard caps input at
 * 64 kib; real synthesis runs are planned, not executed, here.
 */
export function dnavaultencode(bytes: Uint8Array): dnavaultencoderesult {
  if (bytes.length > dnavaultspec.maxinputbytes) {
    throw new quantumerror({
      code: 'archiveguard',
      message: `dnavaultencode is an archive planner: input capped at ${dnavaultspec.maxinputbytes} bytes, got ${bytes.length}`,
      detail: 'use the capacity planner (planodefault) for larger archives',
    });
  }
  const stream: number[] = [
    (bytes.length >>> 24) & 0xff,
    (bytes.length >>> 16) & 0xff,
    (bytes.length >>> 8) & 0xff,
    bytes.length & 0xff,
    ...bytes,
  ];
  const blocks = Math.ceil(stream.length / dnavaultspec.blockpayloadbytes);
  const strands: string[][] = [[], [], [], []];
  for (let b = 0; b < blocks; b++) {
    const payload: number[] = [];
    for (let k = 0; k < dnavaultspec.blockpayloadbytes; k++) {
      payload.push(stream[b * dnavaultspec.blockpayloadbytes + k] ?? 0);
    }
    const hi = (b >>> 8) & 0xff;
    const lo = b & 0xff;
    let sum = hi + lo;
    for (const byte of payload) {
      sum += byte;
    }
    const frame = [hi, lo, ...payload, sum & 0xff];
    let oligo = '';
    let previous = 0;
    for (const byte of frame) {
      let value = byte;
      for (let k = 0; k < dnavaultspec.tritsperbyte; k++) {
        const digit = value % 3;
        value = (value - digit) / 3;
        const base = (digit + previous + 1) % 4;
        oligo += nucleotides[base];
        previous = base;
      }
    }
    strands[b % 4].push(oligo);
    strands[(b + 1) % 4].push(oligo);
  }
  const oligos = blocks * dnavaultspec.redundancy;
  return {
    strands: strands.map((strand) => strand.join('')),
    blocks,
    oligos,
    nucleotides: oligos * dnavaultspec.nucleotidesperblock,
    redundancy: dnavaultspec.redundancy,
    homopolymerrunmax: dnavaultspec.homopolymerrunmax,
    reference: dnavaultspec.reference,
  };
}

/* ------------------------------------------------------------------ */
/* context: dnavault decode (checksums, redundancy, roundtrip)          */
/* ------------------------------------------------------------------ */

/**
 * decodes strands back to bytes: every 210-nucleotide oligo is
 * de-rotated to a 35-byte frame, checksum-verified, deduplicated by
 * block index and reassembled in order. oligos failing checksum or
 * carrying invalid letters are dropped silently because every block
 * exists on two strands; a genuinely missing index throws.
 */
export function dnavaultdecode(strands: readonly string[]): Uint8Array {
  const byindex = new Map<number, number[]>();
  for (const strand of strands) {
    const clean = strand.replace(/\s+/g, '').toUpperCase();
    for (
      let start = 0;
      start + dnavaultspec.nucleotidesperblock <= clean.length;
      start += dnavaultspec.nucleotidesperblock
    ) {
      const oligo = clean.slice(start, start + dnavaultspec.nucleotidesperblock);
      try {
        const frame: number[] = [];
        let previous = 0;
        let value = 0;
        let power = 0;
        for (const letter of oligo) {
          const base = nucleotideindex[letter];
          if (base === undefined) {
            throw new Error(`non-nucleotide letter ${letter}`);
          }
          const digit = (((base - previous - 1) % 4) + 4) % 4;
          if (digit > 2) {
            throw new Error('rotation arithmetic produced an impossible digit');
          }
          value += digit * powersof3[power];
          power += 1;
          if (power === dnavaultspec.tritsperbyte) {
            frame.push(value);
            value = 0;
            power = 0;
          }
          previous = base;
        }
        const index = (frame[0] << 8) | frame[1];
        let sum = frame[0] + frame[1];
        for (let k = 2; k < frame.length - 1; k++) {
          sum += frame[k];
        }
        if ((sum & 0xff) !== frame[frame.length - 1]) {
          throw new Error(`checksum mismatch on block ${index}`);
        }
        if (!byindex.has(index)) {
          byindex.set(index, frame);
        }
      } catch {
        // corrupted oligo: redundancy owns recovery, skip it.
      }
    }
  }
  const count = byindex.size;
  if (count === 0) {
    throw new quantumerror({
      code: 'unrecoverable',
      message: 'no valid dnavault block survived decoding',
    });
  }
  for (let b = 0; b < count; b++) {
    if (!byindex.has(b)) {
      throw new quantumerror({
        code: 'blockmissing',
        message: `dnavault block ${b} is missing across all strands`,
      });
    }
  }
  const stream: number[] = [];
  for (let b = 0; b < count; b++) {
    const frame = byindex.get(b);
    if (!frame) {
      throw new quantumerror({
        code: 'blockmissing',
        message: `dnavault block ${b} vanished between the has check and the read`,
      });
    }
    for (let k = 2; k < frame.length - 1; k++) {
      stream.push(frame[k]);
    }
  }
  const length = ((stream[0] << 24) | (stream[1] << 16) | (stream[2] << 8) | stream[3]) >>> 0;
  if (length > stream.length - 4) {
    throw new quantumerror({
      code: 'lengthcorrupt',
      message: `declared length ${length} exceeds decoded payload ${stream.length - 4}`,
    });
  }
  return Uint8Array.from(stream.slice(4, 4 + length));
}

/* ------------------------------------------------------------------ */
/* context: dnavault capacity planner (215 pb/g)                        */
/* ------------------------------------------------------------------ */

/**
 * dnavault capacity anchors: the widely quoted 215 petabytes per gram
 * of dna figure (church 2012 science era synthesis estimates, echoed
 * by the nature 2013 news coverage around goldman et al.) anchors the
 * physical planner; the codec rates above are what this module
 * actually charges.
 */
export const dnacapacityspec = {
  bytespergram: 2.15e17,
  densityquote: '215 petabytes per gram of dna',
  densityreference: 'church, gao, kosuri 2012 science 337 1628 era estimates; nature news 2013',
  synthesispitch: 'archive planner only; no oligo is ordered or synthesized',
} as const satisfies Record<string, string | number>;

/**
 * dnavault capacity estimate for an archive of sizebytes: dna grams at
 * the 215 pb/g density, oligo and nucleotide counts at this codec's
 * real rates, and the storage overhead ratio.
 */
export function dnacapacity(sizebytes: number): {
  grams: number;
  oligos: number;
  nucleotides: number;
  overhead: number;
  density: string;
  reference: string;
} {
  if (!Number.isFinite(sizebytes) || sizebytes <= 0 || sizebytes > 2 ** 40) {
    throw new quantumerror({
      code: 'sizerange',
      message: `capacity planner accepts archives up to 1 tebibyte, got ${sizebytes}`,
    });
  }
  const payload = sizebytes + 4;
  const blocks = Math.ceil(payload / dnavaultspec.blockpayloadbytes);
  const oligos = blocks * dnavaultspec.redundancy;
  const nucleotides = oligos * dnavaultspec.nucleotidesperblock;
  return {
    grams: sizebytes / dnacapacityspec.bytespergram,
    oligos,
    nucleotides,
    overhead: (blocks * dnavaultspec.blockframebytes + 4) / sizebytes - 1,
    density: dnacapacityspec.densityquote,
    reference: dnacapacityspec.densityreference,
  };
}

/**
 * planodefault: the default dna archive plan for a payload of
 * sizebytes — dna mass in grams (215 pb/g density), number of oligo
 * strands to synthesize, and the codec overhead fraction. this is the
 * planner entry point for the storage tier; nothing is written.
 */
export function planodefault(sizebytes: number): {
  grams: number;
  strands: number;
  overhead: number;
  storage: string;
  reference: string;
} {
  const estimate = dnacapacity(sizebytes);
  return {
    grams: estimate.grams,
    strands: estimate.oligos,
    overhead: estimate.overhead,
    storage: 'dna (goldman 2013 ternary rotation, 4 strands, dual placement)',
    reference: `${dnavaultspec.reference}; ${estimate.reference}`,
  };
}

/* ------------------------------------------------------------------ */
/* context: optical 5d quartz planner (360 tb/disc)                     */
/* ------------------------------------------------------------------ */

/**
 * opticalvault anchors: 5d femtosecond-laser nanostructuring of fused
 * quartz as demonstrated by the university of southampton
 * optoelectronics research centre (zhang, kazansky et al., 2013-2016):
 * 360 tb per disc headline capacity, survival to 1000 c and the quoted
 * 13.8-billion-year room-temperature stability. the five dimensions
 * are three spatial coordinates plus nanograting orientation and
 * retardance. the write parameters below are planning defaults for the
 * femtosecond pass, not device constants.
 */
export const opticalvaultspec = {
  bytesperdisc: 3.6e14,
  layersperdisc: 100,
  logicalbitsperdot: 4,
  redundancycopies: 3,
  stabilityc: 1000,
  lifetimeyearsroom: 1.38e10,
  pulsedurationfs: 280,
  wavelengthnm: 1030,
  layerspacingum: 4.5,
  medium: 'fused quartz',
  dimensions: 'x, y, z + nanograting orientation + retardance',
  reference:
    'zhang, gecavicius, beresna, kazansky 2013 cleo; southampton orc 2013-2016 (360 tb/disc, 13.8 billion years at room temperature)',
} as const satisfies Record<string, string | number>;

/**
 * opticalplan: recording plan for a 5d quartz archive of sizebytes:
 * disc count at 360 tb per disc with three-copy redundancy, layer and
 * nanograting dot counts at 4 logical bits per dot, and the
 * femtosecond write pass description. pure planner output.
 */
export function opticalplan(sizebytes: number): {
  discs: number;
  layers: number;
  dots: number;
  redundancy: number;
  lifetimeyearsroom: number;
  stabilityc: number;
  writeplan: {
    pulsedurationfs: number;
    wavelengthnm: number;
    layerspacingum: number;
    dimensions: string;
  };
  reference: string;
  note: string;
} {
  if (!Number.isFinite(sizebytes) || sizebytes <= 0 || sizebytes > 2 ** 50) {
    throw new quantumerror({
      code: 'sizerange',
      message: `optical planner accepts archives up to 1 pebibyte, got ${sizebytes}`,
    });
  }
  const stored = sizebytes * opticalvaultspec.redundancycopies;
  const discs = Math.max(1, Math.ceil(stored / opticalvaultspec.bytesperdisc));
  const dots = Math.ceil((stored * 8) / opticalvaultspec.logicalbitsperdot);
  return {
    discs,
    layers: discs * opticalvaultspec.layersperdisc,
    dots,
    redundancy: opticalvaultspec.redundancycopies,
    lifetimeyearsroom: opticalvaultspec.lifetimeyearsroom,
    stabilityc: opticalvaultspec.stabilityc,
    writeplan: {
      pulsedurationfs: opticalvaultspec.pulsedurationfs,
      wavelengthnm: opticalvaultspec.wavelengthnm,
      layerspacingum: opticalvaultspec.layerspacingum,
      dimensions: opticalvaultspec.dimensions,
    },
    reference: opticalvaultspec.reference,
    note: 'planning defaults, not device constants; lifetime figure is the quoted upper bound',
  };
}

/* ------------------------------------------------------------------ */
/* context: holographic note (microsoft hsd) and storage compare        */
/* ------------------------------------------------------------------ */

/**
 * holographic storage note for the storage tier compare: microsoft
 * research announced the holographic storage device (hsd) program in
 * 2024 — page-oriented holograms in a photosensitive wafer cartridge,
 * about 1.4 tb per 12-centimeter disc form factor with a multi-terabyte
 * roadmap. this module keeps it as a comparison note only; the
 * concrete planners shipped here are dna and 5d quartz.
 */
export const holographicnote = {
  vendor: 'microsoft research',
  program: 'hsd (holographic storage device), announced 2024',
  capacity: 'about 1.4 tb per 12-cm disc, multi-terabyte roadmap',
  medium: 'photosensitive holographic wafer cartridges',
  position: 'comparison note; no planner shipped for this tier',
} as const satisfies Record<string, string>;

/**
 * storagecompare: one-line planner comparison across the three
 * quantum-adjacent storage tiers this module knows about.
 */
export function storagecompare(sizebytes: number): readonly {
  tier: string;
  units: string;
  massorunits: string;
  lifetime: string;
  reference: string;
}[] {
  const dna = planodefault(sizebytes);
  const optical = opticalplan(sizebytes);
  return [
    {
      tier: 'dna',
      units: `${dna.strands} oligo strands`,
      massorunits: `${dna.grams.toExponential(3)} g of dna`,
      lifetime: 'centuries dry and dark (synthesis-dependent)',
      reference: 'goldman 2013 nature 494 77-80',
    },
    {
      tier: 'optical5d',
      units: `${optical.discs} quartz disc${optical.discs === 1 ? '' : 's'}`,
      massorunits: `${optical.layers} layers, ${optical.dots.toExponential(3)} dots`,
      lifetime: `quoted ${optical.lifetimeyearsroom.toExponential(2)} years at room temperature, ${optical.stabilityc} c survival`,
      reference: 'southampton orc 2013-2016',
    },
    {
      tier: 'holographic',
      units: `${Math.max(1, Math.ceil((sizebytes * 3) / 1.4e12))} hsd discs (planner sketch)`,
      massorunits: 'wafer cartridges',
      lifetime: 'decades, drive-dependent',
      reference: 'microsoft hsd 2024 announcement',
    },
  ];
}

/* ------------------------------------------------------------------ */
/* context: qram bucket brigade (giovannetti 2008, o(log n) routing)    */
/* ------------------------------------------------------------------ */

/**
 * qramcell: one bucket-brigade memory slot addressed by its index.
 */
export interface qramcell {
  readonly address: number;
  readonly value: number;
}

/**
 * qramreadresult: the value plus the routing trace that proves the
 * o(log n) switch activity of the bucket-brigade tree.
 */
export interface qramreadresult {
  readonly address: number;
  readonly value: number;
  readonly hops: number;
  readonly path: readonly number[];
  readonly switchesactive: number;
  readonly classicalwritelines: number;
}

/**
 * qrambucketbrigade: classical simulation of the giovannetti-lloyd-
 * maccone bucket-brigade qram. a classical ram read energizes n word
 * lines; the bucket brigade routes one bus down a binary switch tree so
 * only log2(n) switches per read must flip (and, in the quantum
 * version, only o(log n) qubits must be active, which is what makes
 * quantum-addressed lookup of a superposition affordable). the switch
 * tree is simulated hop by hop and the read result carries the trace.
 * reference: giovannetti, lloyd, maccone, quantum random access memory,
 * prl 100, 160501 (2008); giovannetti, lloyd, maccone, architectures
 * for a quantum random access memory, pra 78, 052310 (2008).
 */
export class qrambucketbrigade {
  readonly #cells: number[];
  readonly #addressbits: number;

  constructor(cells: number) {
    if (!Number.isInteger(cells) || cells < 2 || cells > 256 || (cells & (cells - 1)) !== 0) {
      throw new quantumerror({
        code: 'cellcount',
        message: `qram needs a power-of-two cell count in [2, 256], got ${cells}`,
      });
    }
    this.#cells = new Array<number>(cells).fill(0);
    this.#addressbits = Math.round(Math.log2(cells));
  }

  /** number of addressable cells. */
  get cellscount(): number {
    return this.#cells.length;
  }

  /** address width in bits (the tree depth). */
  get addressbits(): number {
    return this.#addressbits;
  }

  /** switch count of the tree (inner nodes; n - 1 for n cells). */
  get switchcount(): number {
    return this.#cells.length - 1;
  }

  /** classical write into one cell (energizes one word line). */
  write(address: number, value: number): void {
    this.#guardaddress(address);
    this.#cells[address] = value;
  }

  /** lists the cells as an address/value table. */
  cells(): readonly qramcell[] {
    return this.#cells.map((value, address) => ({ address, value }));
  }

  /**
   * routes one read down the bucket-brigade tree: at level l the switch
   * forwards along address bit (addressbits - 1 - l); the bus ends at
   * the leaf and the trace records every switch node id visited
   * (root id 1, children 2i and 2i + 1).
   */
  read(address: number): qramreadresult {
    this.#guardaddress(address);
    const path: number[] = [1];
    let node = 1;
    for (let level = 0; level < this.#addressbits; level++) {
      const bit = (address >> (this.#addressbits - 1 - level)) & 1;
      node = node * 2 + bit;
      path.push(node);
    }
    return {
      address,
      value: this.#cells[address],
      hops: this.#addressbits,
      path,
      switchesactive: this.#addressbits,
      classicalwritelines: this.#cells.length,
    };
  }

  #guardaddress(address: number): void {
    if (!Number.isInteger(address) || address < 0 || address >= this.#cells.length) {
      throw new quantumerror({
        code: 'addressrange',
        message: `qram address must be in [0, ${this.#cells.length - 1}], got ${address}`,
      });
    }
  }
}

/**
 * qramdemo: the n=8 showcase — 3 switch levels, 7 switches, every read
 * routes 3 hops against 8 classical word lines, plus a note of what
 * the quantum version would query in one shot (a superposed address
 * returning a superposed memory word).
 */
export function qramdemo(): {
  reads: readonly qramreadresult[];
  levels: number;
  switches: number;
  hops: number;
  classicalwritelines: number;
  reference: string;
} {
  const qram = new qrambucketbrigade(8);
  for (let address = 0; address < 8; address++) {
    qram.write(address, address * 100 + 7);
  }
  const reads = [qram.read(0), qram.read(3), qram.read(7)];
  return {
    reads,
    levels: qram.addressbits,
    switches: qram.switchcount,
    hops: qram.addressbits,
    classicalwritelines: qram.cellscount,
    reference: 'giovannetti, lloyd, maccone 2008 prl 100 160501',
  };
}

/* ------------------------------------------------------------------ */
/* context: shor plan (theoretical 7-qubit circuit, never executed)     */
/* ------------------------------------------------------------------ */

/**
 * shorcircuitplan: the honest factoring plan. the module ships the
 * theoretical 7-qubit order-finding circuit for n = 15 (3 counting
 * qubits + 4 work qubits, base a in {7, 11}, period 4,
 * gcd(7^2 - 1, 15) = 3 and gcd(7^2 + 1, 15) = 5) and refuses to run it.
 */
export type shorcircuitplan = {
  readonly n: number;
  readonly executable: false;
  readonly qubits: number;
  readonly countingqubits: number;
  readonly workqubits: number;
  readonly bases: readonly number[];
  readonly expectedperiod: number;
  readonly factors: readonly number[];
  readonly stages: readonly string[];
  readonly gatesestimate: number;
  readonly reason: string;
  readonly references: readonly string[];
};

/**
 * shorplan(n): returns the theoretical shor circuit for the
 * factorization and never runs it. honesty clause: compiled
 * controlled-modular-exponentiation networks for any semiprime beyond
 * toy size grow past the 20-qubit statevector budget of this
 * simulator (numbers above 15 need more than 20 clean qubits plus
 * ancillas before scheduling even starts in js), and the 2013
 * "oversimplifying quantum factoring" literature shows compressed
 * order-finding circuits for 15 can factor without any genuine quantum
 * advantage — so the module plans, cites and stops.
 * references: shor 1994 focs / siam j comput 26 1484 (1997);
 * vedal, barenco, ekert 1996 pra 54 147; vandersypen et al. 2001
 * nature 414 883 (the 7-qubit nmr run of 15); smolin, gambetta,
 * smith 2013 pra 87 030302 "oversimplifying quantum factoring".
 */
export function shorplan(n: number): shorcircuitplan {
  if (!Number.isInteger(n) || n < 4) {
    throw new quantumerror({
      code: 'compositerange',
      message: `shorplan needs an integer >= 4, got ${n}`,
    });
  }
  const isfifteen = n === 15;
  const workqubits = isfifteen ? 4 : Math.max(4, Math.ceil(Math.log2(n)));
  const countingqubits = isfifteen ? 3 : Math.max(3, 2 * workqubits - 5);
  const stages = [
    'init work register to |1> (x on the low work qubit)',
    `hadamard over the ${countingqubits} counting qubits (uniform superposition of exponents x)`,
    'controlled a^x mod n per exponent bit (order-4 swap pattern for a in {7, 11} when n = 15)',
    `inverse qft over the ${countingqubits} counting qubits`,
    'measure counting register: phases concentrate on k/4 with r = 4',
    'continued fractions on the measured phase -> candidate order r',
    'gcd(a^(r/2) - 1, n), gcd(a^(r/2) + 1, n) -> classical factors',
  ];
  return {
    n,
    executable: false,
    qubits: countingqubits + workqubits,
    countingqubits,
    workqubits,
    bases: isfifteen ? [7, 11] : [2],
    expectedperiod: isfifteen ? 4 : 0,
    factors: isfifteen ? [3, 5] : [],
    stages,
    gatesestimate: isfifteen ? 400 : countingqubits * workqubits * workqubits * 12,
    reason:
      'theoretical plan only: controlled modular exponentiation for semiprimes beyond 15 exceeds the 20-qubit statevector envelope of this simulator, and compressed 15-circuits are known to factor without quantum advantage (smolin-gambetta-smith 2013)',
    references: [
      'shor 1994 focs; siam j comput 26 1484 (1997)',
      'vedal-barenco-ekert 1996 pra 54 147',
      'vandersypen et al. 2001 nature 414 883',
      'smolin-gambetta-smith 2013 pra 87 030302',
    ],
  };
}

/* ------------------------------------------------------------------ */
/* context: registry (capability catalog)                               */
/* ------------------------------------------------------------------ */

/**
 * freeze helper with a const type parameter so the registry literal
 * keeps its exact readonly member types after freezing.
 */
function freeze<const T extends Record<string, unknown>>(spec: T): Readonly<T> {
  return Object.freeze(spec);
}

/**
 * quantumregistry: the capability catalog of this module for the engine
 * integrator: simulator envelope, provable algorithms, key-exchange
 * protocols, storage tiers, randomness sources and primary citations.
 */
export const quantumregistry = freeze({
  simulator: 'statevector',
  precision: 'float64 interleaved re/im',
  maxqubits: 20,
  algorithms: [
    'bellstate',
    'ghzstate',
    'grover2',
    'grover3',
    'deutsch',
    'qteleport',
    'shorplan (plan only)',
  ] as const,
  protocols: ['bb84', 'e91'],
  storage: ['dna goldman 2013', 'optical 5d quartz', 'holographic note', 'qram bucket brigade'],
  random: ['csprng (node:crypto)', 'anu qrng (optional, fallback)'],
  sources: [
    'goldman et al. 2013 nature 494 77-80 doi:10.1038/nature11875',
    'church, gao, kosuri 2012 science 337 1628 (215 pb/g era)',
    'grover 1996 stoc arxiv:quant-ph/9605043',
    'deutsch-jozsa 1992 proc r soc lond a 439 553',
    'bennett-brassard 1984 bangalore proceedings 175-179',
    'ekert 1991 prl 67 661; chsh 1969 prl 23 880; bell 1964',
    'bennett et al. 1993 prl 70 1895 (teleportation)',
    'giovannetti-lloyd-maccone 2008 prl 100 160501 (qram)',
    'shor 1994/1997; vandersypen 2001 nature 414 883; smolin-gambetta-smith 2013',
    'zhang-kazansky et al. 2013-2016 southampton orc (5d quartz)',
    'microsoft research hsd 2024 announcement',
    'anu quantum numbers, api.quantumnumbers.io',
  ],
});

/** registry type alias for integrators that want the frozen shape. */
export type quantumregistrytype = typeof quantumregistry;

/* ------------------------------------------------------------------ */
/* context: self check (every claim, machine-verified)                  */
/* ------------------------------------------------------------------ */

/**
 * one machine-verified claim row: name, pass flag and a detail line
 * with the measured numbers.
 */
export type quantumcheckrow = {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
};

/**
 * quantumselfcheck: runs every documented claim of this module against
 * the real simulator — bell/grover/deutsch/teleport statistics, bb84
 * with and without an eavesdropper, the e91 chsh violation, the dna
 * roundtrip including strand loss, the qrng range, the qram routing
 * depth, the shor honesty clause, the 20-qubit envelope guard and the
 * using/disposal guard. returns the row table plus pass counts so the
 * integrator can gate ci on it. randomness is live node:crypto, so the
 * protocol rows carry the statistical margins described in their
 * circuit references.
 */
export function quantumselfcheck(): {
  rows: readonly quantumcheckrow[];
  passed: number;
  failed: number;
  reference: string;
} {
  const rows: quantumcheckrow[] = [];
  const push = (name: string, pass: boolean, detail: string): void => {
    rows.push({ name, pass, detail });
  };

  // 1. envelope guard: 21 qubits must be refused.
  let refused = false;
  try {
    new quantumsim(21);
  } catch (cause) {
    refused = cause instanceof quantumerror && cause.code === 'qubitrange';
  }
  push('maxqubits guard', refused, `quantumsim(21) refused: ${refused}`);

  // 2. norm stability under a 12-qubit hadamard ladder.
  {
    using ladder = new quantumsim(12);
    for (let q = 0; q < 12; q++) {
      ladder.h(q);
    }
    const drift = Math.abs(ladder.norm() - 1);
    push(
      'statevector norm',
      drift < 1e-12,
      `12 hadamards leave norm 1 within ${drift.toExponential(2)}`,
    );
  }

  // 3. bell state distribution.
  {
    using bell = bellstate().sim;
    const p = bell.probabilities();
    const ok =
      Math.abs(p[0] - 0.5) < 1e-12 && Math.abs(p[3] - 0.5) < 1e-12 && p[1] < 1e-12 && p[2] < 1e-12;
    push(
      'bellstate',
      ok,
      `probs [${p[0].toFixed(6)}, ${p[1].toFixed(6)}, ${p[2].toFixed(6)}, ${p[3].toFixed(6)}] ~ [0.5, 0, 0.5, 0]`,
    );
  }

  // 4. ghz corners.
  {
    using ghz = ghzstate(4).sim;
    const p = ghz.probabilities();
    const ok = Math.abs(p[0] - 0.5) < 1e-12 && Math.abs(p[15] - 0.5) < 1e-12;
    push('ghzstate(4)', ok, `p[0000]=${p[0].toFixed(6)}, p[1111]=${p[15].toFixed(6)}`);
  }

  // 5. grover2 certainty.
  {
    using g2 = grover2().sim;
    const p11 = g2.probabilities()[3];
    push('grover2', p11 >= 0.99, `prob(11) = ${p11.toFixed(9)} (>= 0.99)`);
  }

  // 6. grover3 statistics.
  {
    using g3 = grover3().sim;
    const p111 = g3.probabilities()[7];
    push('grover3', p111 >= 0.9, `prob(111) = ${p111.toFixed(6)} (theory 0.9461, >= 0.9)`);
  }

  // 7-8. deutsch both promises.
  {
    const constant = deutsch(() => 0);
    const balanced = deutsch((x) => x);
    push(
      'deutsch constant',
      constant.verdict === 'constant' && constant.verdict === constant.expected,
      `f=0 -> ${constant.verdict} (measured ${constant.measured})`,
    );
    push(
      'deutsch balanced',
      balanced.verdict === 'balanced' && balanced.verdict === balanced.expected,
      `f=x -> ${balanced.verdict} (measured ${balanced.measured})`,
    );
  }

  // 9-10. teleportation fidelity for both nontrivial inputs.
  {
    const one = qteleport('one');
    const plus = qteleport('plus');
    push(
      'qteleport |1>',
      Math.abs(one.fidelity - 1) < 1e-12,
      `fidelity ${one.fidelity.toFixed(12)} (corrections m0=${one.outcome0}, m1=${one.outcome1})`,
    );
    push(
      'qteleport |+>',
      Math.abs(plus.fidelity - 1) < 1e-12,
      `fidelity ${plus.fidelity.toFixed(12)} (basis restored after z correction)`,
    );
  }

  // 11-12. bb84 clean channel and intercept-resend.
  {
    const clean = runbb84({ eve: false, bits: 1024 });
    push(
      'bb84 clean',
      clean.qber < 0.05 && !clean.detected,
      `qber ${clean.qber.toFixed(4)} < 0.05, detected ${clean.detected}, sifted ${clean.siftedlen}, key ${clean.keyalice.length} bits`,
    );
    const attacked = runbb84({ eve: true, bits: 1024 });
    push(
      'bb84 intercept-resend',
      attacked.detected && attacked.qber > 0.2,
      `qber ${attacked.qber.toFixed(4)} > 0.2, sampled ${attacked.sampledqber.toFixed(4)} > ${attacked.threshold}, detected ${attacked.detected}`,
    );
  }

  // 13-14. e91 chsh violation and collapse under eve.
  {
    const clean = rune91({ eve: false, pairs: 2400 });
    push(
      'e91 clean chsh',
      clean.s > 2.4 && !clean.detected,
      `s = ${clean.s.toFixed(4)} > 2.4 (tsirelson 2.8284), detected ${clean.detected}, keylen ${clean.keylen}`,
    );
    const attacked = rune91({ eve: true, pairs: 2400 });
    push(
      'e91 intercept-resend',
      attacked.detected,
      `s = ${attacked.s.toFixed(4)} (classical bound 2), qber ${Number.isFinite(attacked.qber) ? attacked.qber.toFixed(4) : 'n/a'}, detected ${attacked.detected}`,
    );
  }

  // 15. dna roundtrip with a strand lost.
  {
    const payload = randomBytes(1000);
    const encoded = dnavaultencode(payload);
    const direct = dnavaultdecode(encoded.strands);
    const degraded = dnavaultdecode([encoded.strands[0], encoded.strands[2], encoded.strands[3]]);
    let equal = direct.length === payload.length && degraded.length === payload.length;
    for (let i = 0; equal && i < payload.length; i++) {
      equal = direct[i] === payload[i] && degraded[i] === payload[i];
    }
    let runmax = 1;
    for (const strand of encoded.strands) {
      let current = 1;
      for (let i = 1; i < strand.length; i++) {
        current = strand[i] === strand[i - 1] ? current + 1 : 1;
        if (current > runmax) {
          runmax = current;
        }
      }
    }
    push(
      'dnavault roundtrip',
      equal && runmax <= 3,
      `1000 bytes roundtrip byte-perfect with strand 1 lost; longest homopolymer run ${runmax} (<= 3)`,
    );
  }

  // 16. qrng range.
  {
    const values = quantuminspiredrandom(4096, { min: -7, max: 19 });
    const distinct = new Set(values).size;
    const inrange = values.every((value) => Number.isInteger(value) && value >= -7 && value < 19);
    push(
      'qrng range',
      inrange && distinct > 16,
      `4096 draws in [-7, 19): all in range ${inrange}, ${distinct} distinct values`,
    );
  }

  // 17. qram routing depth.
  {
    const demo = qramdemo();
    push(
      'qram bucket brigade',
      demo.hops === 3 && demo.switches === 7 && demo.reads.every((read) => read.hops === 3),
      `n=8: ${demo.switches} switches, every read routes ${demo.hops} hops vs ${demo.classicalwritelines} word lines`,
    );
  }

  // 18. shor plan honesty.
  {
    const plan = shorplan(15);
    push(
      'shorplan honest',
      plan.executable === false && plan.qubits === 7 && plan.expectedperiod === 4,
      `n=15 plan: ${plan.qubits} qubits, period ${plan.expectedperiod}, factors [${plan.factors.join(', ')}], execution refused`,
    );
  }

  // 19. using/disposal guard.
  {
    let survivor: quantumsim | undefined;
    {
      using disposable = new quantumsim(2);
      disposable.h(0);
      survivor = disposable;
    }
    let disposed = false;
    try {
      survivor.x(0);
    } catch (cause) {
      disposed = cause instanceof quantumerror && cause.code === 'disposed';
    }
    push('using disposal', disposed, 'post-using gate call threw quantumerror(disposed)');
  }

  const passed = rows.filter((row) => row.pass).length;
  return {
    rows,
    passed,
    failed: rows.length - passed,
    reference: 'task v18-quantum validation matrix; live node:crypto randomness',
  };
}
