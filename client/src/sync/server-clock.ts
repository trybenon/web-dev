/**
 * Часы сервера на клиенте: шлёт sync:ping по расписанию, складывает
 * ответы в ClockEstimator и отвечает, который час на сервере.
 *
 * Сам сокет не знает: отправку получает функцией. Так его можно
 * проверить без сети, а потом без изменений перенести в воркер.
 */
import { ClockEstimator, nextPingDelay } from "./clock";

export class ServerClock {
  private readonly estimator = new ClockEstimator();
  /** Отправить sync:ping с меткой t0. */
  private readonly sendPing: (t0: number) => void;
  /** Монотонные часы клиента. */
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Сколько ответов принято с последнего start. */
  private answered = 0;

  constructor(
    sendPing: (t0: number) => void,
    now: () => number = () => performance.now(),
  ) {
    this.sendPing = sendPing;
    this.now = now;
  }

  /** Начать калибровку заново: при подключении и переподключении. */
  start(): void {
    this.stop();
    this.estimator.reset();
    this.answered = 0;
    this.ping();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Пришёл sync:pong. */
  onPong(t0: number, t1: number, t2: number): void {
    if (this.estimator.add(t0, t1, t2, this.now())) this.answered++;
  }

  /** Сколько ответов принято с последнего start: по ним видно, закончилась ли серия. */
  get answers(): number {
    return this.answered;
  }

  /** Время сервера минус время клиента, мс. null — часы ещё не откалиброваны. */
  offset(): number | null {
    return this.estimator.offset(this.now());
  }

  /** Время сервера, мс. null — часы ещё не откалиброваны. */
  serverNow(): number | null {
    const offset = this.offset();
    return offset === null ? null : this.now() + offset;
  }

  /** Задержка сети туда и обратно, мс. null — замеров нет. */
  rtt(): number | null {
    return this.estimator.rtt(this.now());
  }

  private ping(): void {
    this.sendPing(this.now());
    this.timer = setTimeout(() => this.ping(), nextPingDelay(this.answered));
  }
}
