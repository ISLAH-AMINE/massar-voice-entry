/**
 * Thin wrapper over the Web Speech API (Chrome / Edge).
 * - lang "ar-MA", continuous, interim results, 5 alternatives per phrase
 * - keeps listening: Chrome ends the session after silence, so we restart
 *   while the user wants to listen (with a guard against restart loops)
 * - restart(): drop whatever is being heard and start fresh («عاود», ↻)
 * - watchdog: background chatter can keep a phrase "open" forever (no final
 *   result ever arrives) → restart automatically
 * - push-to-talk: holdStart()/holdEnd() listen only while a button is held
 * - noise suppression: where Chrome accepts a MediaStreamTrack in start(),
 *   feed it a mic track with echo cancellation + noise suppression + AGC
 */
export type VoiceState = 'listening' | 'idle' | 'error';
export interface FinalResult {
  alternatives: string[];
  /** 0..1 as reported by the engine; 0 = not reported */
  confidence: number;
}

/** A phrase still open after this long is chatter keeping the engine busy. */
const STUCK_MS = 12_000;

export class Recognizer {
  onInterim: (text: string) => void = () => {};
  onFinal: (result: FinalResult) => void = () => {};
  onState: (state: VoiceState, message?: string) => void = () => {};
  /** called when the watchdog restarts a stuck phrase */
  onStuck: () => void = () => {};

  /** request a cleaned-up mic track (noise suppression); falls back automatically */
  noiseSuppression = true;

  private rec: any;
  private want = false;
  private running = false;
  private manualRestart = false;
  private restarts: number[] = [];
  private openSince = 0; // when the current (non-final) phrase started
  private watchdog?: number;
  private track: MediaStreamTrack | null = null;
  private trackSupported: boolean | null = null; // null = not tried yet

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

    rec.onstart = () => {
      this.running = true;
      this.onState('listening');
    };
    rec.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const alternatives: string[] = [];
          for (let j = 0; j < r.length; j++) alternatives.push(String(r[j].transcript).trim());
          this.openSince = 0;
          if (alternatives.some(Boolean)) this.onFinal({ alternatives, confidence: Number(r[0].confidence) || 0 });
        } else interim += r[0].transcript;
      }
      interim = interim.trim();
      if (interim && !this.openSince) this.openSince = Date.now();
      if (!interim) this.openSince = 0;
      this.onInterim(interim);
    };
    rec.onerror = (e: any) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return; // normal; onend restarts
      if (e.error === 'audio-capture' && this.trackSupported) {
        // our cleaned-up track failed: go back to Chrome's own microphone capture
        this.trackSupported = false;
        return;
      }
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
      this.running = false;
      this.openSince = 0;
      this.onInterim('');
      if (!this.want) {
        this.stopWatchdog();
        return this.onState('idle');
      }
      if (this.manualRestart) {
        this.manualRestart = false; // «عاود» / watchdog: not a failure, don't count it
      } else {
        const now = Date.now();
        this.restarts = this.restarts.filter((t) => now - t < 10_000);
        if (this.restarts.length >= 6) {
          this.want = false;
          this.stopWatchdog();
          this.onState('error', 'توقف الاستماع (أخطاء متكررة)');
          return;
        }
        this.restarts.push(now);
      }
      this.begin();
    };
    this.rec = rec;
  }

  get listening() {
    return this.want;
  }

  /** Continuous mode: listen until stop(). */
  async start() {
    this.want = true;
    this.restarts = [];
    await this.prepareTrack();
    if (!this.want) return; // stopped while waiting for the mic
    this.begin();
    this.startWatchdog();
  }

  stop() {
    this.want = false;
    this.stopWatchdog();
    try {
      this.rec.stop();
    } catch {
      /* not started */
    }
  }

  /** Drop what is being heard right now and start fresh. */
  restart() {
    if (!this.want) return void this.start();
    this.manualRestart = true;
    this.openSince = 0;
    try {
      this.rec.abort(); // onend → begin()
    } catch {
      this.manualRestart = false;
    }
  }

  /** Push-to-talk: start listening while the button is held … */
  async holdStart() {
    this.want = true;
    await this.prepareTrack();
    if (!this.want) return; // released before the mic was ready
    if (!this.running) this.begin();
  }

  /** … and stop on release; the phrase said so far is still delivered as final. */
  holdEnd() {
    this.want = false;
    try {
      this.rec.stop();
    } catch {
      /* not started */
    }
  }

  private begin() {
    try {
      if (this.track && this.trackSupported !== false && this.track.readyState === 'live') {
        this.rec.start(this.track);
        this.trackSupported = true;
      } else this.rec.start();
    } catch (e: any) {
      if (e?.name === 'InvalidStateError') return; // already running
      if (this.trackSupported !== false && this.track) {
        // this browser doesn't accept a track: use the default capture
        this.trackSupported = false;
        try {
          this.rec.start();
        } catch {
          /* already started */
        }
      }
    }
  }

  private async prepareTrack() {
    if (!this.noiseSuppression || this.trackSupported === false || this.track?.readyState === 'live') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      this.track = stream.getAudioTracks()[0] ?? null;
    } catch {
      this.track = null; // no permission / no device: the engine asks for the mic itself
    }
  }

  private startWatchdog() {
    this.stopWatchdog();
    this.watchdog = window.setInterval(() => {
      if (this.want && this.openSince && Date.now() - this.openSince > STUCK_MS) {
        this.onStuck();
        this.restart();
      }
    }, 1000);
  }

  private stopWatchdog() {
    clearInterval(this.watchdog);
    this.watchdog = undefined;
  }
}
