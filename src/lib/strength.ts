// Password strength meter (zxcvbn-ts, loaded only on password screens) and the
// same checklist the server enforces. The server has the final say: it also
// checks the 10,000 most common passwords and known data breaches.
export interface Rule { id: string; label: string; ok: boolean }

export function rules(pw: string, ctx: { username?: string; displayName?: string } = {}): Rule[] {
  const lower = pw.toLowerCase();
  const mine = [ctx.username ?? '', ...(ctx.displayName ?? '').split(/\s+/)]
    .map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, '')).filter((w) => w.length >= 3);
  return [
    { id: 'len', label: 'At least 8 characters', ok: pw.length >= 8 && pw.length <= 128 },
    { id: 'lower', label: 'A lowercase letter', ok: /[a-z]/.test(pw) },
    { id: 'upper', label: 'A capital letter', ok: /[A-Z]/.test(pw) },
    { id: 'num', label: 'A number', ok: /[0-9]/.test(pw) },
    { id: 'sym', label: 'A symbol, like ! # * or %', ok: /[^A-Za-z0-9]/.test(pw) },
    { id: 'name', label: 'Not your name or username', ok: pw.length > 0 && !mine.some((w) => lower.includes(w)) },
  ];
}

export interface Strength { score: 0 | 1 | 2 | 3 | 4; label: string; warning: string; suggestions: string[]; crack: string }
const LABELS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];

let ready: Promise<(pw: string, inputs: string[]) => Strength> | null = null;
export function loadMeter() {
  ready ??= (async () => {
    const [{ zxcvbn, zxcvbnOptions }, common, en] = await Promise.all([
      import('@zxcvbn-ts/core'), import('@zxcvbn-ts/language-common'), import('@zxcvbn-ts/language-en'),
    ]);
    zxcvbnOptions.setOptions({
      translations: en.translations, graphs: common.adjacencyGraphs,
      dictionary: { ...common.dictionary, ...en.dictionary, farm: ['desert', 'pearl', 'desertpearl', 'tuala', 'kagundo', 'poultry', 'eggs', 'kuku', 'mayai', 'mpesa', 'safaricom'] },
    });
    return (pw: string, inputs: string[]) => {
      const r = zxcvbn(pw, inputs);
      return { score: r.score, label: LABELS[r.score], warning: r.feedback.warning ?? '', suggestions: r.feedback.suggestions ?? [],
               crack: String(r.crackTimesDisplay.offlineSlowHashing1e4PerSecond) };
    };
  })();
  return ready;
}
