/**
 * ============================================================================
 *  SOAL AI ➜ GOOGLE FORM  ·  Web App Google Apps Script
 * ============================================================================
 *  Fungsi    : Membuat soal (pilihan ganda, PG kompleks, dropdown, isian,
 *              essay) dengan AI (Gemini / OpenAI-compatible), menampilkannya
 *              untuk diedit, lalu membangun Google Form siap pakai + kunci
 *              jawaban otomatis (mode Kuis).
 *
 *  File      : Code.gs · AiService.gs · FormBuilder.gs · Index.html · App.html
 *              Stylesheet.html · JavaScript.html
 *
 *  Deploy    : Deploy ▸ New deployment ▸ Type: Web app
 *              Execute as   : Me
 *              Who has access: Anyone with the link  (atau "Anyone within …")
 *
 *  API Key   : Diambil dari Script Properties (kunci: GEMINI_KEYS / OPENAI_KEYS,
 *              dengan GEMINI_API_KEY / OPENAI_API_KEY sebagai fallback versi
 *              lama). Bisa diisi lewat tab "Pengaturan" di web app.
 *              Ambil gratis di https://aistudio.google.com/api-keys
 *              Sejak 2026 AI Studio menerbitkan AUTH key berawalan "AQ.";
 *              Standard key lama "AIza…" masih diterima tetapi dihentikan
 *              Google per September 2026. Key diperlakukan sebagai string
 *              OPAK — jangan validasi awalan, biarkan API yang memutuskan.
 *
 *  Catatan   : Semua fungsi di bawah ini adalah "backend" yang dipanggil dari
 *              sisi client melalui google.script.run.
 * ============================================================================
 */

/** Versi aplikasi — dipakai untuk cache-busting & info di UI. */
var APP_VERSION = '1.0.0';

/* ============================ ENTRY POINT WEB APP ======================== */

/** Menampilkan halaman utama web app. */
function doGet(e) {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Soal AI ➜ Google Form')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Memungkinkan Index.html melakukan <?!= include('Stylesheet') ?> dsb. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* ============================ KONFIGURASI & API KEY ====================== */
/**
 * ATURAN MENGIKAT (diadaptasi dari LessonLen §10):
 *  - Key HANYA di Script Properties. Tidak pernah masuk kode, spreadsheet,
 *    log, atau browser. Di UI hanya ditampilkan sebagai "key#3" + 4 digit
 *    terakhir.
 *  - Beberapa key boleh dipasang sekaligus; AiService merotasinya
 *    round-robin dan memberi cooldown otomatis saat kuota habis.
 */

/** Nama Script Property key tunggal (legacy) per provider. */
function keyNameFor_(provider) {
  return String(provider || 'gemini').toLowerCase() === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY';
}

/** Model default per provider. */
function defaultModelFor_(provider) {
  return String(provider || 'gemini').toLowerCase() === 'openai'
    ? 'gpt-4o-mini' : AiService.MODEL_BAWAAN[0];
}

/**
 * Konfigurasi AI untuk sisi client.
 * TIDAK pernah mengirim key utuh — hanya jumlah, ekor 4 digit, dan status.
 */
function getAiConfig() {
  var props = PropertiesService.getScriptProperties();
  var provider = (props.getProperty('AI_PROVIDER') || 'gemini').toLowerCase();

  /* `statusKeys()` bergantung pada CacheService (scope script.storage). Bila
     scope itu belum diotorisasi — mis. deployment masih versi lama — seluruh
     konfigurasi JANGAN ikut gagal, atau UI akan tampak "tidak bisa menyimpan
     key" padahal key-nya sudah tersimpan. */
  var st;
  try {
    st = AiService.statusKeys(provider);
  } catch (err) {
    var fallback = [];
    try {
      var mentah = props.getProperty(provider === 'openai' ? 'OPENAI_KEYS' : 'GEMINI_KEYS') ||
        props.getProperty(provider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY') || '';
      var arr = mentah.charAt(0) === '[' ? JSON.parse(mentah) : [mentah];
      fallback = arr.filter(function (k) { return String(k || '').trim().length > 10; })
        .map(function (k, i) {
          return { index: i, label: 'key#' + i, ekor: String(k).slice(-4), status: 'siap' };
        });
    } catch (e2) { fallback = []; }
    st = {
      terpasang: fallback.length > 0, jml: fallback.length, key: fallback,
      jml_siap: fallback.length, jml_istirahat: 0, jml_bermasalah: 0, cursor: 0,
      model_pilihan: props.getProperty('GEMINI_MODEL') || '',
      model_aktif: '', model: AiService.MODEL_BAWAAN.slice(),
      peringatan: 'CacheService/scope script.storage belum aktif: ' + err.message
    };
  }

  return {
    provider: provider,
    version: APP_VERSION,
    userEmail: getEmail_(),

    /* --- key --- */
    hasKey: st.terpasang,
    jmlKey: st.jml,
    keySiap: st.jml_siap,
    keyIstirahat: st.jml_istirahat,
    keyBermasalah: st.jml_bermasalah,
    keyCursor: st.cursor,
    keys: st.key,                       // [{index,label,ekor,status}]
    keyMasked: st.key.length            // tampilan ringkas utk header
      ? st.jml + ' key (' + st.key.map(function (k) { return k.ekor; }).join(', ') + ')'
      : '',

    /* --- model --- */
    model: st.model_pilihan || '',      // '' = rotasi bawaan
    modelAktif: st.model_aktif,
    modelRotasi: st.model,              // urutan yang akan dicoba
    autoRotate: !st.model_pilihan,
    defaultModels: {
      gemini: AiService.MODEL_BAWAAN.slice(),
      openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini']
    },
    baseUrl: props.getProperty('AI_BASE_URL') || '',
    batasDetik: Math.round(AiService.BATAS_TOTAL_MS / 1000),
    peringatan: st.peringatan || cacheWarning_()
  };
}

/**
 * Menyimpan konfigurasi AI (provider, model, baseUrl, dan key).
 * @param {Object} cfg {provider, model, apiKey|apiKeys, baseUrl}
 *   apiKey  : string — boleh satu key, atau beberapa dipisah baris/koma
 *   apiKeys : array  — alternatif
 *   Nilai kosong / tersamar (mengandung * • …) berarti "jangan ubah key".
 */
function saveAiConfig(cfg) {
  cfg = cfg || {};
  var props = PropertiesService.getScriptProperties();
  var provider = String(cfg.provider || props.getProperty('AI_PROVIDER') || 'gemini').toLowerCase();
  props.setProperty('AI_PROVIDER', provider);

  if (typeof cfg.baseUrl !== 'undefined') {
    if (String(cfg.baseUrl).trim()) props.setProperty('AI_BASE_URL', String(cfg.baseUrl).trim());
    else props.deleteProperty('AI_BASE_URL');
  }

  /* model: '' / 'auto' berarti rotasi bawaan */
  if (typeof cfg.model !== 'undefined') {
    AiService.simpanModel(cfg.model);
  }

  var daftar = cfg.apiKeys;
  var peringatanSimpan = '';
  if (!daftar && cfg.apiKey) daftar = String(cfg.apiKey).split(/[\n,;]+/);
  if (daftar) {
    var bersih = (Array.isArray(daftar) ? daftar : [daftar])
      .map(function (k) { return String(k || '').trim(); })
      .filter(function (k) { return k.length && !/[*\u2022\u2026]/.test(k); });
    if (bersih.length) {
      var hasilSimpan = AiService.simpanKeys(bersih, provider);
      /* Peringatan format (mis. Standard key AIza yang sedang dihentikan, atau
         key Gemini dipasang pada provider OpenAI) TIDAK membatalkan penyimpanan
         — tetapi harus sampai ke UI supaya guru tidak bingung saat key-nya
         tiba-tiba ditolak API. */
      peringatanSimpan = (hasilSimpan && hasilSimpan.peringatan) || '';
    }
  }

  /* Key SUDAH tersimpan pada titik ini. Apa pun yang terjadi setelahnya
     (mis. statusKeys gagal karena scope CacheService) tidak boleh membuat
     pemanggil mengira penyimpanan gagal. */
  var jml = 0;
  try { jml = AiService.statusKeys(provider).jml; } catch (e) { jml = -1; }
  log_('saveAiConfig', {
    provider: provider,
    model: cfg.model || '(rotasi)',
    jmlKey: jml
  });

  var hasil = getAiConfig();
  if (peringatanSimpan) {
    hasil.peringatan = hasil.peringatan
      ? (peringatanSimpan + ' ' + hasil.peringatan)
      : peringatanSimpan;
  }
  return hasil;
}

/**
 * Peringatan bila CacheService tidak tersedia (scope script.storage belum aktif).
 * Rotasi key tetap jalan, hanya cooldown & penanda model mati tidak bekerja.
 */
function cacheWarning_() {
  try {
    var e = AiService.cacheError ? AiService.cacheError() : '';
    return e ? ('CacheService tidak aktif (' + e + '). Rotasi key tetap jalan, tetapi ' +
      'cooldown kuota & penanda model mati tidak bekerja. Jalankan fungsi onSetup sekali ' +
      'untuk mengotorisasi scope script.storage, lalu deploy ulang sebagai versi baru.') : '';
  } catch (err) { return ''; }
}

/** Menyimpan banyak key sekaligus (dipanggil dari textarea UI). */
function saveAiKeys(apiKeys, provider) {
  try {
    var daftar = Array.isArray(apiKeys)
      ? apiKeys
      : String(apiKeys || '').split(/[\n,;]+/);
    var bersih = daftar.map(function (k) { return String(k || '').trim(); })
      .filter(function (k) { return k.length; });
    if (!bersih.length) {
      return {
        ok: false, kode: 'VALIDASI_GAGAL',
        error: 'Tidak ada key yang bisa disimpan. Tempel minimal satu API key Gemini ' +
          'dari https://aistudio.google.com/api-keys (Auth key baru diawali "AQ.", ' +
          'Standard key lama "AIza…" juga diterima) — satu key per baris.'
      };
    }
    var res = AiService.simpanKeys(bersih, provider || '');
    return { ok: true, jml: res.jml, config: getAiConfig() };
  } catch (err) {
    return { ok: false, error: errMsg_(err), kode: err.kode || '' };
  }
}

/** Status key & model untuk panel guru. */
function getKeyStatus() {
  try {
    var provider = (PropertiesService.getScriptProperties().getProperty('AI_PROVIDER') || 'gemini').toLowerCase();
    return { ok: true, status: AiService.statusKeys(provider) };
  } catch (err) {
    return { ok: false, error: errMsg_(err) };
  }
}

/** Buang seluruh cooldown ("Coba Lagi Sekarang"). */
function resetAiCooldown() {
  AiService.resetCooldown();
  return { ok: true, config: getAiConfig() };
}

/** Menghapus seluruh API key tersimpan. */
function clearAiKey() {
  var props = PropertiesService.getScriptProperties();
  var provider = (props.getProperty('AI_PROVIDER') || 'gemini').toLowerCase();
  props.deleteProperty(provider === 'openai' ? 'OPENAI_KEYS' : 'GEMINI_KEYS');
  props.deleteProperty(keyNameFor_(provider));
  AiService.resetCooldown();
  return getAiConfig();
}

/**
 * Uji koneksi ke AI. Mencoba seluruh key × model seperti alur nyata,
 * sehingga hasilnya benar-benar mencerminkan kondisi kuota saat ini.
 */
function testAiConnection(model) {
  try {
    if (model) AiService.simpanModel(model);
    var out = AiService.panggil('Balas tepat dengan kata: OK', {
      systemInstruction: 'Kamu adalah asisten uji koneksi. Jawab sangat singkat.',
      suhu: 0,
      maksToken: 64,
      thinking: 'off'
    });
    return {
      ok: true,
      message: 'Koneksi berhasil · model ' + out.model + ' · key#' + out.key_index +
        ' · ' + out.durasi_ms + ' ms · balasan: "' + String(out.teks).trim().slice(0, 40) + '"',
      model: out.model,
      key: 'key#' + out.key_index
    };
  } catch (err) {
    return { ok: false, message: 'Gagal — ' + errMsg_(err) };
  }
}

/** Daftar model Gemini yang tersedia untuk key terpasang. */
function listGeminiModels() {
  return AiService.listGeminiModels();
}

/* ============================ API UTAMA (DIPANGGIL DARI UI) ============= */

/**
 * Generate soal via AI.
 * @param {Object} spec Konfigurasi soal (lihat AiService.buildPrompt_).
 * @return {Object} {ok, questions, meta} atau {ok:false, error}
 */
function generateQuestions(spec) {
  try {
    validateSpec_(spec);
    var result = AiService.generateQuestions(spec);
    log_('generateQuestions', {
      mapel: spec.mapel || '',
      jumlah: result.questions.length,
      model: result.meta.model,
      ms: result.meta.elapsedMs
    });
    return { ok: true, questions: result.questions, meta: result.meta };
  } catch (err) {
    log_('generateQuestions:ERROR', { message: err.message });
    return { ok: false, error: errMsg_(err), kode: err.kode || '' };
  }
}

/**
 * Generate ulang SATU soal (dipakai tombol 🔄 per kartu soal).
 * @param {Object} spec Konfigurasi soal keseluruhan.
 * @param {Number} index Index soal yang diganti (0-based).
 * @param {Array}  existing Daftar soal yang sudah ada (untuk menghindari duplikasi).
 */
function regenerateOneQuestion(spec, index, existing) {
  try {
    validateSpec_(spec);
    var one = AiService.regenerateQuestion(spec, index, existing || []);
    return { ok: true, question: one };
  } catch (err) {
    return { ok: false, error: err.message, kode: err.kode || '' };
  }
}

/**
 * Membangun Google Form dari daftar soal (opsi lengkap: kuis, folder, kunci
 * jawaban, dsb).
 * @param {Object} payload {spec, questions, form:{...}}
 */
function buildFormFromQuestions(payload) {
  try {
    payload = payload || {};
    var questions = payload.questions || [];
    if (!questions.length) throw new Error('Daftar soal kosong. Generate soal terlebih dahulu.');
    var result = FormBuilder.build(payload);
    log_('buildForm', { jumlah: result.jumlahSoal, formId: result.formId });
    return { ok: true, result: result };
  } catch (err) {
    log_('buildForm:ERROR', { message: err.message });
    return { ok: false, error: err.message };
  }
}

/** Mengunduh semua soal sebagai file JSON di Drive (untuk arsip/impor ulang). */
function exportQuestionsToDrive(payload) {
  try {
    payload = payload || {};
    var folder = FormBuilder.resolveFolder_((payload.form || {}).folderId);
    var name = ((payload.form || {}).title || 'Bank Soal AI') + ' - bank-soal.json';
    var file = folder.createFile(name, JSON.stringify(payload.questions || [], null, 2), MimeType.PLAIN_TEXT);
    return { ok: true, url: file.getUrl() };
  } catch (err) {
    return { ok: false, error: errMsg_(err) };
  }
}

/* ============================ SETUP / DIAGNOSTIK ========================= */

/**
 * Dijalankan sekali setelah deploy untuk memastikan scope & properti siap.
 * Buka dari editor Apps Script ▸ fungsi onSetup ▸ Run.
 */
function onSetup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('AI_PROVIDER')) props.setProperty('AI_PROVIDER', 'gemini');
  if (!props.getProperty('AI_MODEL')) props.setProperty('AI_MODEL', defaultModelFor_('gemini'));

  // Pancing otorisasi scope Drive / Forms / Spreadsheet.
  var f = FormApp.create('__cek_scope_hapus_saya__');
  f.setIsQuiz(true).setShowLinkToRespondAgain(false);
  f.addMultipleChoiceItem().setTitle('Contoh').setChoiceValues(['A', 'B']).setFeedbackForCorrect(
    FormApp.createFeedback().setText('Benar!').build()
  );
  var folder = FormBuilder.resolveFolder_('');
  var file = folder.createFile('__cek_scope_hapus_saya__.txt', 'ok', MimeType.PLAIN_TEXT);
  var ss = SpreadsheetApp.create('__cek_scope_hapus_saya__');

  var ids = [f.getId(), file.getId(), ss.getId()];
  DriveApp.getFileById(file.getId()).setTrashed(true);
  DriveApp.getFileById(ss.getId()).setTrashed(true);
  DriveApp.getFileById(f.getId()).setTrashed(true);

  return {
    ok: true,
    message: 'Setup selesai. Scope sudah diotorisasi. File uji (' + ids.length + ') telah dihapus.',
    email: getEmail_(),
    config: getAiConfig()
  };
}

/* ============================ UTILITAS =================================== */

/** Validasi ringan konfigurasi soal sebelum memanggil AI. */
function validateSpec_(spec) {
  spec = spec || {};
  if (!String(spec.topik || spec.materi || '').trim()) {
    throw new Error('Topik / materi soal wajib diisi.');
  }
  var n = Number(spec.jumlah || 0);
  if (!(n >= 1 && n <= 50)) throw new Error('Jumlah soal harus antara 1 sampai 50.');
}

/** Menyamarkan API key: AIzaSyDxxxx…Q7k */
function maskKey_(key) {
  if (!key) return '';
  if (key.length <= 10) return '••••••';
  return key.substring(0, 6) + '••••••' + key.substring(key.length - 4);
}

/**
 * Mengubah apa pun yang dilempar server menjadi pesan string yang terbaca.
 * Tanpa ini, sisi client menerima objek dan mencetak "[object Object]".
 */
function errMsg_(e) {
  if (e === null || typeof e === 'undefined') return 'Terjadi kesalahan tanpa pesan.';
  if (typeof e === 'string') return e;
  if (e.message) {
    /* `e.name` sengaja tidak dipakai: nilainya "Error" untuk hampir semua
       exception dan hanya menghasilkan awalan berisik "[Error] …". */
    var kode = e.kode || '';
    return (kode ? '[' + kode + '] ' : '') + String(e.message);
  }
  if (e.name && e.name !== 'Error') return String(e.name);
  try {
    var j = JSON.stringify(e);
    return (j && j !== '{}') ? j : String(e);
  } catch (err2) { return String(e); }
}

/** Email user yang menjalankan script (bergantung setelan "Execute as"). */
function getEmail_() {
  try {
    return Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || '';
  } catch (e) {
    return '';
  }
}

/** Log ringkas ke Logger + Sheet "Log" di Drive (opsional, aman bila gagal). */
function log_(tag, data) {
  var line = '[' + new Date().toISOString() + '] ' + tag + ' ' + JSON.stringify(data || {});
  try { Logger.log(line); } catch (e) {}
  try {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('ENABLE_SHEET_LOG') !== 'true') return;
    var id = props.getProperty('LOG_SHEET_ID');
    var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.create('Log Soal AI');
    if (!id) props.setProperty('LOG_SHEET_ID', ss.getId());
    var sh = ss.getSheets()[0];
    if (sh.getLastRow() === 0) sh.appendRow(['Waktu', 'Tag', 'Detail', 'User']);
    sh.appendRow([new Date(), tag, JSON.stringify(data || {}), getEmail_()]);
  } catch (e) { /* jangan sampai logging menggagalkan proses utama */ }
}
