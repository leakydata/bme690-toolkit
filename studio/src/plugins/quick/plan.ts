/**
 * The schedule for a guided experiment, kept free of UI so it can be tested.
 *
 * Default method: repeated rounds. Each class is recorded several times,
 * alternating, so the model can't learn "first half vs second half" (drift,
 * the room warming up) instead of the smell, and every round is a separate
 * specimen the honest test can hold out. The order flips every round
 * (A B, B A, A B ...) so no class always follows the same one.
 *
 * Each block starts with a settling period: the sensors take a while to
 * respond to the new sample and to clear the last one. It is recorded but
 * left without a class, so training ignores it.
 */

export type Method = 'rounds' | 'bosch';

export interface ExperimentPlan {
  title: string;
  /** what is being told apart, 2 to 4 things */
  classes: string[];
  /** a sentence per class telling the user what to do */
  prompts: string[];
  method: Method;
  rounds: number;
  /** length of each block, settling included */
  minutes: number;
  settleSeconds: number;
}

export interface Block {
  className: string;
  prompt: string;
  round: number;
  settleSeconds: number;
  recordSeconds: number;
  /** specimen name for the recorded part */
  label: string;
}

export const SETTLE_LABEL = 'settling';

export interface Template {
  id: string;
  title: string;
  blurb: string;
  classes: string[];
  prompts: string[];
}

export const TEMPLATES: Template[] = [
  {
    id: 'coffee',
    title: 'Coffee vs air',
    blurb: 'The classic first experiment: can the sensors tell a cup of coffee from clean air?',
    classes: ['Air', 'Coffee'],
    prompts: [
      'Take the coffee away and let clean air reach the sensors. Open a window or wave the air if the room smells of coffee.',
      'Put the coffee (a cup, or fresh grounds in an open jar) a few centimetres from the sensors.',
    ],
  },
  {
    id: 'fruit',
    title: 'Fresh vs rotten fruit',
    blurb: 'Spot spoilage by smell. Use two pieces of the same fruit: one fresh, one overripe.',
    classes: ['Fresh', 'Rotten'],
    prompts: [
      'Put the fresh fruit next to the sensors, and move the rotten one well away.',
      'Put the overripe fruit next to the sensors, and move the fresh one well away.',
    ],
  },
  {
    id: 'custom',
    title: 'Your own',
    blurb: 'Name two to four things you want to tell apart.',
    classes: ['Sample A', 'Sample B'],
    prompts: ['Put sample A next to the sensors.', 'Put sample B next to the sensors.'],
  },
];

export function defaultPlan(t: Template): ExperimentPlan {
  return {
    title: t.title,
    classes: [...t.classes],
    prompts: [...t.prompts],
    method: 'rounds',
    rounds: 4,
    minutes: 5,
    settleSeconds: 60,
  };
}

/** Bosch's tutorial: one 30-minute block per class. */
export function boschPlan(p: ExperimentPlan): ExperimentPlan {
  return { ...p, method: 'bosch', rounds: 1, minutes: 30, settleSeconds: 120 };
}

export function schedule(p: ExperimentPlan): Block[] {
  const out: Block[] = [];
  const total = Math.max(1, Math.round(p.minutes * 60));
  const settle = Math.min(Math.max(0, Math.round(p.settleSeconds)), total - 30);
  for (let r = 1; r <= Math.max(1, p.rounds); r++) {
    const order = p.classes.map((_, i) => i);
    if (r % 2 === 0) order.reverse();
    for (const i of order) {
      out.push({
        className: p.classes[i],
        prompt: p.prompts[i] ?? `Put ${p.classes[i]} next to the sensors.`,
        round: r,
        settleSeconds: Math.max(0, settle),
        recordSeconds: total - Math.max(0, settle),
        label: p.rounds > 1 ? `${p.classes[i]} ${r}` : p.classes[i],
      });
    }
  }
  return out;
}

export function totalSeconds(p: ExperimentPlan): number {
  return schedule(p).reduce((n, b) => n + b.settleSeconds + b.recordSeconds, 0);
}

/** Which class a recorded specimen belongs to, from its label. */
export function classOfLabel(p: ExperimentPlan, label: string): string | null {
  if (label === SETTLE_LABEL) return null;
  for (const c of p.classes) {
    if (label === c || (label.startsWith(`${c} `) && /^\d+$/.test(label.slice(c.length + 1)))) return c;
  }
  return null;
}

/** Plain-English problems with a plan, or null when it is fine. */
export function planProblem(p: ExperimentPlan): string | null {
  const names = p.classes.map((c) => c.trim());
  if (names.length < 2) return 'Name at least two things to tell apart.';
  if (names.some((n) => !n)) return 'Every thing to tell apart needs a name.';
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) return 'Give each thing a different name.';
  if (names.some((n) => n.toLowerCase() === SETTLE_LABEL)) return `"${SETTLE_LABEL}" is reserved; choose another name.`;
  if (p.minutes < 1) return 'Each block needs at least a minute.';
  if (p.rounds < 1) return 'Record at least one round.';
  return null;
}

/** How far the score can be trusted, given the method. */
export function honestyNote(p: ExperimentPlan): string {
  if (p.rounds >= 3) {
    return `Each thing is recorded ${p.rounds} separate times, so the test can use rounds the model never trained on. That gives an honest score.`;
  }
  if (p.rounds === 2) {
    return 'With two rounds, the test holds out one round of each. That is honest, but a third round makes the score steadier.';
  }
  return 'With one block per thing, there is nothing unseen to test on, so the score will be optimistic. Record another session on a different day to check it.';
}
