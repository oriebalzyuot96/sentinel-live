import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import type { AlertType, ObjectClass, Severity } from '../../shared/protocol';

export type Lang = 'en' | 'ar';

const en = {
  appName: 'Sentinel Live',
  tagline: 'Real-time video analytics',
  skip: 'Skip to camera wall',
  simulatedFeed: 'Simulated feed',
  simulatedOperator: 'Simulated operator',
  liveFeed: 'Live server',
  replayBadge: 'Replay',
  pausedBadge: 'Paused',
  language: 'العربية',
  languageLabel: 'Switch language to Arabic',
  soundOn: 'Sound on',
  soundOff: 'Sound off',
  // KPIs
  kpiObjects: 'Objects tracked',
  kpiAlertsMin: 'Alerts / min',
  kpiConfidence: 'Avg confidence',
  kpiLatency: 'End-to-end latency',
  kpiFps: 'Avg FPS',
  // camera wall
  cameraWall: 'Camera wall',
  openCamera: 'Open {name} in focus view',
  focusView: 'Focus view',
  close: 'Close',
  heatmap: 'Heatmap',
  trails: 'Trails',
  zones: 'Zones & lines',
  tracks: 'Active tracks',
  noTracks: 'No objects in view',
  camAlerts: 'Recent alerts on this camera',
  // alerts
  alertFeed: 'Live alerts',
  filters: 'Filters',
  severity: 'Severity',
  type: 'Type',
  camera: 'Camera',
  allCameras: 'All cameras',
  showAcked: 'Show acknowledged',
  mineOnly: 'Assigned to me',
  ack: 'Acknowledge',
  acked: 'Acknowledged',
  ackedBy: 'Ack by {name}',
  ackAll: 'Ack all',
  mute: 'Mute this type on this camera',
  muted: 'Muted rules',
  unmute: 'Unmute',
  assign: 'Assign',
  assignTo: 'Assign to {name}',
  assignedTo: 'Assigned to {name}',
  discuss: 'Discuss',
  noAlerts: 'No alerts match the current filters.',
  track: 'Track',
  // charts
  analytics: 'Analytics',
  perClass: 'Objects per class · last 60 s',
  alertsTimeline: 'Alerts timeline · last 5 min',
  occupancy: 'Occupancy heatmap · people per camera · last 60 s',
  now: 'now',
  ago: '{n} s ago',
  minAgo: '{n} min ago',
  // connection
  connection: 'Connection',
  status: 'Status',
  stConnecting: 'Connecting…',
  stLive: 'Live',
  stReconnecting: 'Reconnecting in {s} s (attempt {n})',
  stSimulated: 'Simulated feed',
  reasonForced: 'demo mode requested (?demo=1)',
  reasonConfig: 'static build, no server',
  reasonFallback: 'server unreachable, running in-browser simulator',
  reasonManual: 'switched manually',
  rtt: 'Round-trip',
  eps: 'Events / s',
  protocol: 'Protocol',
  buffer: 'Replay buffer',
  pause: 'Pause stream',
  resume: 'Resume stream',
  replay: 'Replay last 30 s',
  stopReplay: 'Stop replay',
  tryLive: 'Try live server',
  useSim: 'Use simulator',
  // chat
  chat: 'Operator chat',
  openChat: 'Open chat',
  dock: 'Dock panel',
  undock: 'Float panel',
  general: 'General',
  rooms: 'Rooms',
  typeMessage: 'Message… (@ to mention)',
  send: 'Send',
  emoji: 'Insert emoji',
  isTyping: '{name} is typing…',
  loadOlder: 'Load older messages',
  noMessages: 'No messages yet. Say hello.',
  stPending: 'Sending',
  stFailed: 'Not sent, will retry on reconnect',
  stSent: 'Sent',
  stDelivered: 'Delivered',
  stRead: 'Read',
  retry: 'Retry',
  you: 'You',
  online: 'online',
  away: 'away',
  offline: 'offline',
  operator: 'Operator',
  chooseOperator: 'Choose operator',
  displayName: 'Display name',
  save: 'Save',
  cancel: 'Cancel',
  operatorHint: 'Open the app in a second tab as the other operator to chat live.',
  // notifications
  notifications: 'Notifications',
  markAllRead: 'Mark all read',
  noNotifications: 'You are all caught up.',
  enableDesktop: 'Enable desktop notifications',
  desktopOn: 'Desktop notifications on',
  desktopBlocked: 'Desktop notifications blocked by the browser',
  nAssigned: '{by} assigned you an alert',
  nAcked: '{by} acknowledged an alert',
  nMention: '{by} mentioned you',
  nMessage: 'New message from {by}',
  dismiss: 'Dismiss',
  // footer
  disclaimer:
    'Portfolio demo with simulated detections and synthetic scenes. Not a production video-analytics system.',
  builtBy: 'Built by Orieb Alzyuot',
};

export type I18nKey = keyof typeof en;

const ar: Record<I18nKey, string> = {
  appName: 'سنتينل لايف',
  tagline: 'تحليلات فيديو لحظية',
  skip: 'انتقل إلى جدار الكاميرات',
  simulatedFeed: 'بث محاكى',
  simulatedOperator: 'مشغّل محاكى',
  liveFeed: 'خادم مباشر',
  replayBadge: 'إعادة',
  pausedBadge: 'متوقف مؤقتًا',
  language: 'English',
  languageLabel: 'تبديل اللغة إلى الإنجليزية',
  soundOn: 'الصوت مفعّل',
  soundOff: 'الصوت مكتوم',
  kpiObjects: 'الأجسام المتتبَّعة',
  kpiAlertsMin: 'تنبيهات / دقيقة',
  kpiConfidence: 'متوسط الثقة',
  kpiLatency: 'زمن الاستجابة الكلي',
  kpiFps: 'متوسط الإطارات/ث',
  cameraWall: 'جدار الكاميرات',
  openCamera: 'فتح {name} في العرض المركّز',
  focusView: 'عرض مركّز',
  close: 'إغلاق',
  heatmap: 'خريطة حرارية',
  trails: 'مسارات الحركة',
  zones: 'المناطق والخطوط',
  tracks: 'المسارات النشطة',
  noTracks: 'لا توجد أجسام في المشهد',
  camAlerts: 'أحدث تنبيهات هذه الكاميرا',
  alertFeed: 'التنبيهات المباشرة',
  filters: 'عوامل التصفية',
  severity: 'الخطورة',
  type: 'النوع',
  camera: 'الكاميرا',
  allCameras: 'كل الكاميرات',
  showAcked: 'إظهار المؤكَّدة',
  mineOnly: 'المسندة إليّ',
  ack: 'تأكيد الاستلام',
  acked: 'تم التأكيد',
  ackedBy: 'أكّده {name}',
  ackAll: 'تأكيد الكل',
  mute: 'كتم هذا النوع على هذه الكاميرا',
  muted: 'قواعد الكتم',
  unmute: 'إلغاء الكتم',
  assign: 'إسناد',
  assignTo: 'إسناد إلى {name}',
  assignedTo: 'مسند إلى {name}',
  discuss: 'نقاش',
  noAlerts: 'لا توجد تنبيهات مطابقة لعوامل التصفية.',
  track: 'المسار',
  analytics: 'التحليلات',
  perClass: 'الأجسام حسب الفئة · آخر 60 ث',
  alertsTimeline: 'خط زمني للتنبيهات · آخر 5 دقائق',
  occupancy: 'خريطة الإشغال · الأشخاص لكل كاميرا · آخر 60 ث',
  now: 'الآن',
  ago: 'قبل {n} ث',
  minAgo: 'قبل {n} د',
  connection: 'الاتصال',
  status: 'الحالة',
  stConnecting: 'جارٍ الاتصال…',
  stLive: 'مباشر',
  stReconnecting: 'إعادة الاتصال خلال {s} ث (المحاولة {n})',
  stSimulated: 'بث محاكى',
  reasonForced: 'تم طلب الوضع التجريبي (?demo=1)',
  reasonConfig: 'نسخة ثابتة بلا خادم',
  reasonFallback: 'تعذّر الوصول إلى الخادم، يعمل المحاكي داخل المتصفح',
  reasonManual: 'تم التبديل يدويًا',
  rtt: 'زمن الذهاب والإياب',
  eps: 'أحداث / ث',
  protocol: 'البروتوكول',
  buffer: 'مخزن الإعادة',
  pause: 'إيقاف البث مؤقتًا',
  resume: 'استئناف البث',
  replay: 'إعادة آخر 30 ث',
  stopReplay: 'إيقاف الإعادة',
  tryLive: 'تجربة الخادم المباشر',
  useSim: 'استخدام المحاكي',
  chat: 'محادثة المشغّلين',
  openChat: 'فتح المحادثة',
  dock: 'تثبيت اللوحة',
  undock: 'تعويم اللوحة',
  general: 'عام',
  rooms: 'الغرف',
  typeMessage: 'رسالة… (@ للإشارة)',
  send: 'إرسال',
  emoji: 'إدراج رمز تعبيري',
  isTyping: '{name} يكتب…',
  loadOlder: 'تحميل رسائل أقدم',
  noMessages: 'لا رسائل بعد. ابدأ بالتحية.',
  stPending: 'جارٍ الإرسال',
  stFailed: 'لم تُرسل، ستُعاد عند الاتصال',
  stSent: 'أُرسلت',
  stDelivered: 'وصلت',
  stRead: 'قُرئت',
  retry: 'إعادة المحاولة',
  you: 'أنت',
  online: 'متصل',
  away: 'بعيد',
  offline: 'غير متصل',
  operator: 'المشغّل',
  chooseOperator: 'اختيار المشغّل',
  displayName: 'الاسم الظاهر',
  save: 'حفظ',
  cancel: 'إلغاء',
  operatorHint: 'افتح التطبيق في تبويب ثانٍ بصفة المشغّل الآخر للمحادثة مباشرة.',
  notifications: 'الإشعارات',
  markAllRead: 'تعليم الكل كمقروء',
  noNotifications: 'لا جديد لديك.',
  enableDesktop: 'تفعيل إشعارات سطح المكتب',
  desktopOn: 'إشعارات سطح المكتب مفعّلة',
  desktopBlocked: 'المتصفح يحظر إشعارات سطح المكتب',
  nAssigned: 'أسند إليك {by} تنبيهًا',
  nAcked: 'أكّد {by} تنبيهًا',
  nMention: 'أشار إليك {by}',
  nMessage: 'رسالة جديدة من {by}',
  dismiss: 'إخفاء',
  disclaimer: 'عرض توضيحي لمعرض الأعمال باكتشافات محاكاة ومشاهد اصطناعية. ليس نظام تحليلات فيديو إنتاجيًا.',
  builtBy: 'من تطوير Orieb Alzyuot',
};

const severityLabels: Record<Lang, Record<Severity, string>> = {
  en: { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' },
  ar: { low: 'منخفضة', medium: 'متوسطة', high: 'عالية', critical: 'حرجة' },
};

const typeLabels: Record<Lang, Record<AlertType, string>> = {
  en: {
    intrusion: 'Intrusion',
    loitering: 'Loitering',
    crowding: 'Crowding',
    'abandoned-object': 'Abandoned object',
    'line-crossing': 'Line crossing',
  },
  ar: {
    intrusion: 'اقتحام',
    loitering: 'تسكّع',
    crowding: 'ازدحام',
    'abandoned-object': 'جسم متروك',
    'line-crossing': 'عبور خط',
  },
};

const classLabels: Record<Lang, Record<ObjectClass, string>> = {
  en: { person: 'People', vehicle: 'Vehicles', bag: 'Bags' },
  ar: { person: 'أشخاص', vehicle: 'مركبات', bag: 'حقائب' },
};

const STORAGE_KEY = 'sentinel.lang';

@Injectable({ providedIn: 'root' })
export class I18n {
  private readonly doc = inject(DOCUMENT);
  readonly lang = signal<Lang>(readLang());
  readonly dir = computed(() => (this.lang() === 'ar' ? 'rtl' : 'ltr'));
  private readonly dict = computed(() => (this.lang() === 'ar' ? ar : en));
  private readonly timeFmt = computed(
    () => new Intl.DateTimeFormat(this.lang() === 'ar' ? 'ar-u-nu-latn' : 'en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
  );

  constructor() {
    effect(() => {
      const root = this.doc.documentElement;
      root.lang = this.lang();
      root.dir = this.dir();
      try {
        localStorage.setItem(STORAGE_KEY, this.lang());
      } catch {
        /* storage unavailable */
      }
    });
  }

  toggle(): void {
    this.lang.update((l) => (l === 'en' ? 'ar' : 'en'));
  }

  t(key: I18nKey, params?: Record<string, string | number>): string {
    let s = this.dict()[key];
    if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
    return s;
  }

  severity(s: Severity): string {
    return severityLabels[this.lang()][s];
  }

  alertType(t: AlertType): string {
    return typeLabels[this.lang()][t];
  }

  cls(c: ObjectClass): string {
    return classLabels[this.lang()][c];
  }

  time(ts: number): string {
    return this.timeFmt().format(ts);
  }

  num(n: number, digits = 0): string {
    return n.toLocaleString(this.lang() === 'ar' ? 'ar-u-nu-latn' : 'en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
}

function readLang(): Lang {
  try {
    const q = new URLSearchParams(location.search).get('lang');
    if (q === 'ar' || q === 'en') return q;
    const s = localStorage.getItem(STORAGE_KEY);
    if (s === 'ar' || s === 'en') return s;
  } catch {
    /* ignore */
  }
  return 'en';
}
