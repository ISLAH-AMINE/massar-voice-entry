/**
 * Thin wrapper over the Web Speech API (Chrome / Edge).
 * - lang "ar-MA", continuous, interim results, 5 alternatives per phrase
 * - keeps listening: Chrome ends the session after silence, so we restart
 *   while the user wants to listen (with a guard against restart loops)
 */
export type VoiceState = 'listening' | 'idle' | 'error';

export class Recognizer {
  onInterim: (text: string) => void = () => {};
  onFinal: (alternatives: string[]) => void = () => {};
  onState: (state: VoiceState, message?: string) => void = () => {};

  private rec: any;
  private want = false;
  private restarts: number[] = [];

  static supported(): boolean {
    return !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  }

  constructor(lang = 'ar-MA') {
    const C = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec = new C();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 5; // more readings = more chances to find the name

    rec.onstart = () => this.onState('listening');
    rec.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const alts: string[] = [];
          for (let j = 0; j < r.length; j++) alts.push(String(r[j].transcript).trim());
          if (alts.some(Boolean)) this.onFinal(alts);
        } else interim += r[0].transcript;
      }
      this.onInterim(interim.trim());
    };
    rec.onerror = (e: any) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return; // normal; onend restarts
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.want = false;
        this.onState('error', 'الميكروفون غير مسموح — اسمح به من شريط العنوان');
      } else if (e.error === 'network') {
        this.onState('error', 'التعرف على الصوت يحتاج إلى الإنترنت');
      } else if (e.error === 'language-not-supported') {
        this.want = false;
        this.onState('error', 'لغة ar-MA غير مدعومة في هذا المتصفح');
      } else this.onState('error', String(e.error));
    };
    rec.onend = () => {
      this.onInterim('');
      if (!this.want) return this.onState('idle');
      const now = Date.now();
      this.restarts = this.restarts.filter((t) => now - t < 10_000);
      if (this.restarts.length >= 6) {
        this.want = false;
        this.onState('error', 'توقف الاستماع (أخطاء متكررة)');
        return;
      }
      this.restarts.push(now);
      try {
        rec.start();
      } catch {
        /* already started */
      }
    };
    this.rec = rec;
  }

  get listening() {
    return this.want;
  }

  start() {
    this.want = true;
    this.restarts = [];
    try {
      this.rec.start();
    } catch {
      /* already started */
    }
  }

  stop() {
    this.want = false;
    try {
      this.rec.stop();
    } catch {
      /* not started */
    }
  }
}
