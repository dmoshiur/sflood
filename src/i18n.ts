export type Language = 'en' | 'bn';

const copy = {
  en: {
    'nav.home': 'Home', 'nav.about': 'Project', 'nav.dashboard': 'Dashboard', 'nav.devices': 'Devices', 'nav.guides': 'Build guide',
    'nav.owner': 'Owner console', 'nav.signIn': 'Sign in', 'nav.openDemo': 'Open demo', 'nav.menu': 'Open navigation',
    'safety.title': 'EDUCATIONAL PROTOTYPE · NOT A LIFE-SAFETY SYSTEM',
    'safety.body': 'Preview readings are simulated; connected telemetry, if configured, is unverified. Do not connect this prototype to real flood defenses or rely on it for public warnings.',
    'hero.eyebrow': 'SMART FLOOD CONTROL & AUTOMATION',
    'hero.title': 'When water rises, your response should be ready.',
    'hero.body': 'FloodGuard is a student science-fair prototype combining ultrasonic sensing, an ESP32 controller, a servo-driven model barrier, and clear local alerts.',
    'hero.cta': 'Open the live simulation', 'hero.secondary': 'Explore the build guide',
    'dashboard.title': 'Flood monitor', 'dashboard.subtitle': 'A simulated sensor view for the River Island City tray model.',
    'dashboard.updated': 'Sample telemetry · updates only when you interact', 'dashboard.level': 'Water level',
    'dashboard.barrier': 'Model barrier', 'dashboard.sensor': 'Sensor health', 'dashboard.rain': 'Rain sensor',
    'dashboard.devices': 'Connected devices', 'dashboard.watchlist': 'State & alert feed', 'dashboard.recent': 'Recent telemetry',
    'dashboard.simulator': 'Science-fair simulator', 'dashboard.simulatorNote': 'Move the sample water level to test thresholds. These controls never command physical hardware.',
    'action.rise': 'Water +5 cm', 'action.recede': 'Water −6 cm', 'action.sensorFault': 'Simulate sensor fault',
    'action.recover': 'Restore sensor', 'action.estop': 'Test E-stop', 'action.clearEstop': 'Release test E-stop', 'action.reset': 'Reset demo',
    'state.NORMAL': 'NORMAL', 'state.RECOVERY': 'RECOVERY', 'state.WATCH': 'WATCH', 'state.WARNING': 'WARNING', 'state.CRITICAL': 'CRITICAL', 'state.UNKNOWN': 'UNKNOWN', 'state.FAULT': 'FAULT',
    'barrier.DOWN': 'DOWN', 'barrier.RAISING': 'RAISING', 'barrier.RAISED': 'RAISED', 'barrier.FAULT': 'FAULT', 'barrier.HOLD': 'HOLD POSITION',
    'status.online': 'ONLINE', 'status.offline': 'OFFLINE',
    'footer.disclaimer': 'Educational demonstration only. Not for real-world flood protection or emergency response.',
  },
  bn: {
    'nav.home': 'হোম', 'nav.about': 'প্রকল্প', 'nav.dashboard': 'ড্যাশবোর্ড', 'nav.devices': 'ডিভাইস', 'nav.guides': 'নির্মাণ নির্দেশিকা',
    'nav.owner': 'মালিক কনসোল', 'nav.signIn': 'সাইন ইন', 'nav.openDemo': 'ডেমো খুলুন', 'nav.menu': 'নেভিগেশন খুলুন',
    'safety.title': 'শিক্ষামূলক প্রোটোটাইপ · জীবন-নিরাপত্তা ব্যবস্থা নয়',
    'safety.body': 'প্রিভিউর রিডিং সিমুলেটেড; সংযুক্ত টেলিমেট্রি থাকলেও তা যাচাইহীন। বাস্তব বন্যা প্রতিরক্ষায় যুক্ত করবেন না বা জনসতর্কতার জন্য নির্ভর করবেন না।',
    'hero.eyebrow': 'স্মার্ট বন্যা নিয়ন্ত্রণ ও স্বয়ংক্রিয়তা',
    'hero.title': 'পানি বাড়লে, প্রস্তুত থাকুক আপনার প্রতিক্রিয়া।',
    'hero.body': 'FloodGuard একটি শিক্ষার্থী বিজ্ঞান-মেলা প্রোটোটাইপ—আল্ট্রাসনিক সেন্সর, ESP32 কন্ট্রোলার, সার্ভো-চালিত মডেল বাঁধ এবং স্পষ্ট স্থানীয় সতর্কতা একত্র করে।',
    'hero.cta': 'লাইভ সিমুলেশন খুলুন', 'hero.secondary': 'নির্মাণ নির্দেশিকা দেখুন',
    'dashboard.title': 'বন্যা পর্যবেক্ষণ', 'dashboard.subtitle': 'River Island City ট্রে-মডেলের জন্য সিমুলেটেড সেন্সর ভিউ।',
    'dashboard.updated': 'নমুনা টেলিমেট্রি · শুধু আপনার ইন্টারঅ্যাকশনে আপডেট', 'dashboard.level': 'পানির উচ্চতা',
    'dashboard.barrier': 'মডেল বাঁধ', 'dashboard.sensor': 'সেন্সরের অবস্থা', 'dashboard.rain': 'বৃষ্টির সেন্সর',
    'dashboard.devices': 'সংযুক্ত ডিভাইস', 'dashboard.watchlist': 'অবস্থা ও সতর্কতা', 'dashboard.recent': 'সাম্প্রতিক টেলিমেট্রি',
    'dashboard.simulator': 'বিজ্ঞান-মেলা সিমুলেটর', 'dashboard.simulatorNote': 'থ্রেশহোল্ড পরীক্ষা করতে নমুনা পানির উচ্চতা বদলান। এই কন্ট্রোল বাস্তব হার্ডওয়্যার চালায় না।',
    'action.rise': 'পানি +৫ সেমি', 'action.recede': 'পানি −৬ সেমি', 'action.sensorFault': 'সেন্সর ত্রুটি দেখান',
    'action.recover': 'সেন্সর ঠিক করুন', 'action.estop': 'ই-স্টপ পরীক্ষা', 'action.clearEstop': 'পরীক্ষার ই-স্টপ ছাড়ুন', 'action.reset': 'ডেমো রিসেট',
    'state.NORMAL': 'স্বাভাবিক', 'state.RECOVERY': 'পুনরুদ্ধার', 'state.WATCH': 'পর্যবেক্ষণ', 'state.WARNING': 'সতর্কতা', 'state.CRITICAL': 'জরুরি', 'state.UNKNOWN': 'অজানা', 'state.FAULT': 'ত্রুটি',
    'barrier.DOWN': 'নিচে', 'barrier.RAISING': 'উঠছে', 'barrier.RAISED': 'উঠানো', 'barrier.FAULT': 'ত্রুটি', 'barrier.HOLD': 'অবস্থান ধরে রাখুন',
    'status.online': 'সচল', 'status.offline': 'বিচ্ছিন্ন',
    'footer.disclaimer': 'শুধু শিক্ষামূলক প্রদর্শনী। বাস্তব বন্যা প্রতিরক্ষা বা জরুরি সেবার জন্য নয়।',
  },
} as const;

export type CopyKey = keyof typeof copy.en;
export function translate(language: Language, key: CopyKey) {
  return copy[language][key] || copy.en[key];
}
