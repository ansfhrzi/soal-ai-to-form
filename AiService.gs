/**
 * ============================================================================
 *  AiService.gs — Lapisan AI (Gemini) dengan ROTASI KEY × MODEL
 * ============================================================================
 *  Diadaptasi dari LessonLen/Ai.gs (KESEPAKATAN-SISTEM v4.7 §8, §10).
 *
 *  ATURAN MENGIKAT:
 *   1. Key HANYA di Script Properties (`GEMINI_KEYS`). Tidak pernah masuk
 *      kode, spreadsheet, log, atau browser. Di log/UI dirujuk sebagai
 *      "key#3" dan 4 digit terakhir saja.
 *   2. AI selalu menghasilkan DRAF. Tidak ada jalur otomatis dari AI ke
 *      Google Form tanpa ditinjau guru di tab Pratinjau.
 *   3. Rotasi key ROUND-ROBIN, bukan acak: beban merata & mudah ditelusuri.
 *   4. Maksimal SATU putaran key per model per permintaan.
 *   5. Berhenti bila akumulasi > 240 detik (batas eksekusi Apps Script
 *      6 menit masih menyisakan ruang untuk membangun Form).
 *
 *  MENGAPA ROTASI DUA SUMBU (key × model)?
 *   Kuota gratis Gemini dihitung per (project × MODEL). Saat satu model
 *   kehabisan jatah harian, model lain pada key yang sama MASIH punya jatah
 *   sendiri — kapasitas berlipat tanpa menambah key.
 * ============================================================================
 */

var AiService = (function () {

  /* ====================== KONSTANTA ===================================== */

  var PROP_KEYS   = 'GEMINI_KEYS';         // JSON array of API keys
  var PROP_CURSOR = 'GEMINI_KEY_CURSOR';   // posisi round-robin terakhir
  var PROP_MODEL  = 'GEMINI_MODEL';        // pilihan guru (opsional)
  var PROP_LEGACY = 'GEMINI_API_KEY';      // versi lama: 1 key tunggal
  var PROP_PROVIDER = 'AI_PROVIDER';
  var PROP_OPENAI_KEYS = 'OPENAI_KEYS';
  var PROP_OPENAI_MODEL = 'AI_MODEL';
  var PROP_BASE_URL = 'AI_BASE_URL';

  var MODEL_BAWAAN = [
    'gemini-3.6-flash',        /* terbaru, dipakai guru */
    'gemini-3.5-flash',        /* terverifikasi masih gratis */
    'gemini-3.5-flash-lite',   /* kuota harian paling longgar */
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.0-flash'
  ];
  var MODEL = MODEL_BAWAAN[0];             /* dipakai saat mencatat riwayat */

  var GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';
  var OPENAI_BASE_DEFAULT = 'https://api.openai.com/v1';

  /* Satu panggilan Gemini bisa 25-40 detik untuk soal banyak. Batas 90
     detik membuat rotasi berhenti setelah ~2 percobaan — terlalu cepat
     menyerah. 240 detik masih aman dari batas 6 menit Apps Script. */
  var BATAS_TOTAL_MS = 240000;
  var CD_MENIT    = 60;      /* 429 kuota per-menit → istirahat 60 detik   */
  var CD_HARIAN   = 3600;    /* 429 kuota HARIAN    → istirahat 1 jam      */
  var CD_RUSAK    = 86400;   /* 400/401/403 soal key → cooldown 24 jam     */
  var JEDA_SERVER = 2000;    /* 500/503 → jeda 2 detik                     */

  /* Urutan mengikuti contoh resmi Google yang memakai "low". "minimal"
     lebih hemat tetapi tidak semua model menerimanya. Bila ditolak,
     nilai berikutnya dicoba dan diingat 24 jam. */
  var LEVEL_URUT = ['low', 'minimal'];

  var MAKS_KEY = 20;

  /* ====================== UTILITAS UMUM ================================= */

  function _err(kode, pesan) {
    var e = new Error(pesan);
    e.kode = kode;
    return e;
  }

  function _props() { return PropertiesService.getScriptProperties(); }

  /* CacheService butuh scope script.storage. Bila scope itu belum diotorisasi,
     aplikasi TETAP jalan (rotasi tanpa cooldown & tanpa penanda model mati),
     tetapi penyebabnya harus terlihat — jangan gagal diam-diam. */
  var _cacheErr = '';
  function _cache() {
    try {
      var c = CacheService.getScriptCache();
      _cacheErr = '';
      return c;
    } catch (e) {
      _cacheErr = String(e && e.message ? e.message : e);
      return null;
    }
  }
  function cacheError() { return _cacheErr; }

  function _log(tag, data) {
    try {
      if (typeof log_ === 'function') log_(tag, data);
    } catch (e) { /* logging tidak boleh membatalkan proses utama */ }
  }

  function _sleep(ms) { try { Utilities.sleep(ms); } catch (e) {} }

  /* ====================== KEY =========================================== */

  /**
   * Daftar key dari Script Properties. Tidak pernah keluar dari modul ini.
   * Kompatibel ke belakang: bila `GEMINI_KEYS` kosong tetapi `GEMINI_API_KEY`
   * (versi lama) terisi, key lama itu dipakai sebagai satu-satunya key.
   */
  function _keys(provider) {
    var p = _props();
    var mentah = p.getProperty(provider === 'openai' ? PROP_OPENAI_KEYS : PROP_KEYS);
    var daftar = [];
    if (mentah) {
      try {
        var a = JSON.parse(mentah);
        if (Array.isArray(a)) {
          daftar = a.filter(function (k) { return String(k || '').trim().length > 10; });
        }
      } catch (e) { daftar = []; }
    }
    if (!daftar.length && provider !== 'openai') {
      var lama = p.getProperty(PROP_LEGACY);
      if (lama && String(lama).trim().length > 10) daftar = [String(lama).trim()];
    }
    if (!daftar.length && provider === 'openai') {
      var lamaOa = p.getProperty('OPENAI_API_KEY');
      if (lamaOa && String(lamaOa).trim().length > 10) daftar = [String(lamaOa).trim()];
    }
    return daftar;
  }

  /**
   * Simpan daftar key. Dipanggil dari UI guru atau editor Apps Script.
   * Nilai lama ditimpa seluruhnya.
   */
  function simpanKeys(daftar, provider) {
    provider = provider || _provider();
    if (typeof daftar === 'string') {
      daftar = daftar.split(/[\n,;]+/);
    }
    if (!Array.isArray(daftar)) {
      throw _err('VALIDASI_GAGAL', 'Daftar key harus berupa larik atau teks satu key per baris.');
    }

    var bersih = daftar
      .map(function (k) { return String(k || '').trim(); })
      .filter(function (k) { return k.length > 0; });

    if (bersih.length > MAKS_KEY) {
      throw _err('VALIDASI_GAGAL', 'Maksimal ' + MAKS_KEY + ' key.');
    }

    for (var i = 0; i < bersih.length; i++) {
      /* Bentuk key Google: AIza… 39 karakter. Pemeriksaan ini sekadar
         mencegah salah tempel — bukan jaminan key-nya sah. */
      var k = bersih[i];
      if (provider !== 'openai') {
        /* Yang paling sering salah tempel: TOKEN otorisasi sementara dari tombol
           "Authorize with Google" (AQ.…, ya29.…, 4/0A…), OAuth code (4%2F…),
           atau Access Token AI Studio. Bentuknya mirip key, panjangnya cukup,
           tetapi Gemini akan menolaknya dengan 400 "API key not valid" — dan
           key itu lalu ditandai rusak 24 jam. Tolak di depan dengan pesan yang
           menyebut cara mengambil key yang benar. */
        var polaToken = /^(AQ\.|ya29\.|4\/|4%2F|1\/\/|access_token$)/i;
        if (polaToken.test(k) || k === 'access_token') {
          throw _err('VALIDASI_GAGAL',
            'Key ke-' + (i + 1) + ' ("' + k.slice(0, 6) + '…") adalah TOKEN otorisasi sementara, ' +
            'BUKAN Gemini API key. Ambil key yang benar di https://aistudio.google.com/apikey ' +
            '→ "Create API key" → salin yang diawali "AIza" (±39 karakter).');
        }
        if (k.length >= 30 && k.indexOf('AIza') !== 0) {
          throw _err('VALIDASI_GAGAL',
            'Key ke-' + (i + 1) + ' tidak diawali "AIza" (terima: "' + k.slice(0, 6) + '…"). ' +
            'Gemini API key selalu berbentuk AIza… dengan panjang ±39 karakter. ' +
            'Ambil di https://aistudio.google.com/apikey.');
        }
        if (k.indexOf(' ') !== -1) {
          throw _err('VALIDASI_GAGAL',
            'Key ke-' + (i + 1) + ' (…' + k.slice(-4) + ') mengandung spasi — ' +
            'tempel satu key per baris tanpa spasi.');
        }
        if (k.length < 30) {
          throw _err('VALIDASI_GAGAL',
            'Key ke-' + (i + 1) + ' terlalu pendek (' + k.length + ' karakter, terpotong?). ' +
            'API key Gemini berbentuk AIza… dengan panjang ±39 karakter.');
        }
        if (k.indexOf('\u2022') !== -1 || k.indexOf('*') !== -1) {
          throw _err('VALIDASI_GAGAL',
            'Key ke-' + (i + 1) + ' tampak seperti versi tersamar (mengandung • atau *), ' +
            'bukan key asli. Tempel ulang dari AI Studio.');
        }
      } else if (k.indexOf(' ') !== -1) {
        throw _err('VALIDASI_GAGAL', 'Key ke-' + (i + 1) + ' mengandung spasi.');
      }
    }

    _props().setProperty(provider === 'openai' ? PROP_OPENAI_KEYS : PROP_KEYS,
      JSON.stringify(bersih));
    _resetCooldownSemua(Math.max(bersih.length, 1));
    _log('simpan_api_key', { provider: provider, jumlah: bersih.length });
    return { jml: bersih.length, provider: provider };
  }

  /** Status key untuk panel guru. HANYA 4 digit terakhir yang ditampilkan. */
  function statusKeys(provider) {
    provider = provider || _provider();
    var keys = _keys(provider);
    var model = provider === 'openai' ? [_modelOpenAi()] : _daftarModel();
    var rusak = 0, siap = 0;

    var daftar = keys.map(function (k, i) {
      var status;
      if (_keyRusak(i)) { status = 'bermasalah'; rusak++; }
      else {
        /* key dianggap siap bila MASIH ada model yang belum cooldown */
        var bebas = model.filter(function (m) { return !_sedangCooldown(i, m); });
        if (bebas.length) { status = 'siap'; siap++; }
        else status = 'istirahat';
      }
      return { index: i, label: 'key#' + i, ekor: String(k).slice(-4), status: status };
    });

    return {
      provider: provider,
      jml: keys.length,
      terpasang: keys.length > 0,
      cursor: keys.length ? _cursor() % keys.length : 0,
      jml_siap: siap,
      jml_bermasalah: rusak,
      jml_istirahat: keys.length - siap - rusak,
      model: model,
      model_aktif: model.length ? model[0] : '',
      model_pilihan: _modelPilihan(),
      key: daftar
    };
  }

  /** Buang seluruh cooldown — dipakai tombol "Coba Lagi Sekarang". */
  function resetCooldown() {
    _resetCooldownSemua(Math.max(_keys().length, 1));
    _log('reset_cooldown_ai', {});
    return { direset: true };
  }

  function _cursor() {
    var v = _props().getProperty(PROP_CURSOR);
    var n = Number(v);
    return isFinite(n) && n >= 0 ? n : 0;
  }

  function _simpanCursor(n) {
    try { _props().setProperty(PROP_CURSOR, String(n)); } catch (e) {}
  }

  /* ====================== COOLDOWN & TANDA (CacheService) =============== */

  /** Cooldown disimpan per pasangan key+model, bukan per key saja. */
  function _cd(i, model) { return 'gemini_cd_' + i + '_' + (model || ''); }

  function _sedangCooldown(i, model) {
    var c = _cache(); if (!c) return false;
    try { return c.get(_cd(i, model)) !== null; } catch (e) { return false; }
  }

  function _pasangCooldown(i, model, detik, sebab) {
    var c = _cache(); if (!c) return;
    try { c.put(_cd(i, model), sebab || '1', detik); } catch (e) {}
  }

  /** Key ditolak (bukan sekadar kuota) berlaku untuk SEMUA model. */
  function _pasangCooldownKey(i, detik, sebab) {
    var c = _cache(); if (!c) return;
    try {
      MODEL_BAWAAN.forEach(function (m) { c.put(_cd(i, m), sebab, detik); });
      c.put('gemini_key_rusak_' + i, sebab, detik);
    } catch (e) {}
  }

  function _keyRusak(i) {
    var c = _cache(); if (!c) return false;
    try { return c.get('gemini_key_rusak_' + i) !== null; } catch (e) { return false; }
  }

  /** Model yang terbukti tidak ada (404) dibuang selama 24 jam. */
  function _modelMati(m) {
    var c = _cache(); if (!c) return false;
    try { return c.get('gemini_mdl_' + m) !== null; } catch (e) { return false; }
  }
  function _tandaiModelMati(m) {
    var c = _cache(); if (!c) return;
    try { c.put('gemini_mdl_' + m, '1', 86400); } catch (e) {}
  }

  /** Model yang terbukti menolak responseSchema — ingat 24 jam. */
  function _modelTanpaSkema(m) {
    var c = _cache(); if (!c) return false;
    try { return c.get('gemini_nosk_' + m) !== null; } catch (e) { return false; }
  }
  function _tandaiTanpaSkema(m) {
    var c = _cache(); if (!c) return;
    try { c.put('gemini_nosk_' + m, '1', 86400); } catch (e) {}
  }

  /** Model yang tidak mengenal thinkingConfig — ingat 24 jam. */
  function _modelTanpaThink(m) {
    var c = _cache(); if (!c) return false;
    try { return c.get('gemini_noth_' + m) !== null; } catch (e) { return false; }
  }
  function _tandaiTanpaThink(m) {
    var c = _cache(); if (!c) return;
    try { c.put('gemini_noth_' + m, '1', 86400); } catch (e) {}
  }

  /**
   * Bentuk thinkingConfig yang cocok untuk sebuah model.
   *  'level'  → thinkingLevel  (seri 3.x)
   *  'budget' → thinkingBudget (seri 2.5)
   * Tebakan awal dari nama model, lalu dikoreksi oleh jawaban server.
   */
  function _gayaThink(m) {
    var c = _cache();
    if (c) { try { var t = c.get('gemini_gaya_' + m); if (t) return t; } catch (e) {} }
    return /gemini-3/i.test(m) ? 'level' : 'budget';
  }
  function _tandaiGaya(m, gaya) {
    var c = _cache(); if (!c) return;
    try { c.put('gemini_gaya_' + m, gaya, 86400); } catch (e) {}
  }

  function _levelThink(m) {
    var c = _cache();
    if (c) { try { var v = c.get('gemini_lvl_' + m); if (v) return v; } catch (e) {} }
    return LEVEL_URUT[0];
  }
  function _tandaiLevel(m, v) {
    var c = _cache(); if (!c) return;
    try { c.put('gemini_lvl_' + m, v, 86400); } catch (e) {}
  }

  function _resetCooldownSemua(jml) {
    var c = _cache(); if (!c) return;
    try {
      var kunci = [];
      for (var i = 0; i < (jml || MAKS_KEY); i++) {
        kunci.push('gemini_key_rusak_' + i);
        MODEL_BAWAAN.forEach(function (m) { kunci.push(_cd(i, m)); });
      }
      MODEL_BAWAAN.forEach(function (m) {
        kunci.push('gemini_mdl_' + m);
        kunci.push('gemini_nosk_' + m);
        kunci.push('gemini_noth_' + m);
        kunci.push('gemini_gaya_' + m);
        kunci.push('gemini_lvl_' + m);
      });
      /* CacheService.removeAll maksimal 100 kunci per panggilan */
      for (var s = 0; s < kunci.length; s += 100) {
        c.removeAll(kunci.slice(s, s + 100));
      }
    } catch (e) {}
  }

  /* ====================== MODEL ========================================= */

  function _provider() {
    return String(_props().getProperty(PROP_PROVIDER) || 'gemini').toLowerCase();
  }

  function _modelPilihan() {
    try { return _props().getProperty(PROP_MODEL) || ''; } catch (e) { return ''; }
  }

  /** Daftar model yang akan dicoba; pilihan guru didahulukan. */
  function _daftarModel() {
    var pilihan = '';
    try { pilihan = _props().getProperty(PROP_MODEL) || _props().getProperty('AI_MODEL') || ''; } catch (e) {}
    pilihan = String(pilihan).trim();

    var daftar = MODEL_BAWAAN.slice();
    if (pilihan && daftar.indexOf(pilihan) === -1) daftar.unshift(pilihan);
    else if (pilihan) {
      daftar = [pilihan].concat(daftar.filter(function (m) { return m !== pilihan; }));
    }
    /* model yang terbukti tidak ada (404) dibuang selama 24 jam */
    var hidup = daftar.filter(function (m) { return !_modelMati(m); });
    return hidup.length ? hidup : daftar;
  }

  /** Simpan model pilihan guru. Kosongkan untuk kembali ke rotasi bawaan. */
  function simpanModel(nama) {
    var m = String(nama || '').trim();
    if (m === 'auto' || m === 'rotasi') m = '';
    if (m && !/^[a-z0-9._\-\/:]+$/i.test(m)) {
      throw _err('VALIDASI_GAGAL', 'Nama model tidak wajar.');
    }
    try {
      if (m) _props().setProperty(PROP_MODEL, m);
      else _props().deleteProperty(PROP_MODEL);
    } catch (e) {}
    _resetCooldownSemua(Math.max(_keys().length, 1));
    _log('ganti_model_ai', { model: m || '(rotasi bawaan)' });
    return { model: m || MODEL_BAWAAN[0], rotasi: !m, daftar: _daftarModel() };
  }

  function _modelOpenAi() {
    try {
      return _props().getProperty(PROP_OPENAI_MODEL) || 'gpt-4o-mini';
    } catch (e) { return 'gpt-4o-mini'; }
  }

  /* ====================== MUATAN PERMINTAAN ============================= */

  /** Tambahan instruksi saat skema JSON tidak dapat dipakai. */
  function _promptPolos(prompt) {
    return prompt + '\n\nBalas HANYA dengan JSON valid, ' +
      'tanpa teks pembuka maupun pagar kode.';
  }

  /**
   * Susun badan permintaan Gemini.
   * `polos` membuang pengaturan JSON terstruktur (sebagian model belum
   * mendukung responseSchema/responseMimeType).
   */
  function _muatan(prompt, opsi, polos, tanpaThinking, gaya, level) {
    var cfg = {
      temperature: opsi.suhu === undefined ? 0.7 : opsi.suhu,
      maxOutputTokens: opsi.maksToken || 8192
    };

    /* Gemini 2.5+ menyalakan "thinking" secara BAWAAN, dan token berpikir
       dipotong dari maxOutputTokens yang sama. Proses berpikir memakan
       hampir seluruh jatah sehingga jawaban terpotong — gejalanya balasan
       sependek "Here is" dengan finishReason MAX_TOKENS.

       PENTING: `thinkingBudget` dan `thinkingLevel` SALING EKSKLUSIF —
       mengirim keduanya ditolak dengan "You can only set only one of
       thinking budget and thinking level." Seri 2.5 memakai budget, seri
       3.x memakai level, jadi bentuknya dipilih per model dan bentuk yang
       ditolak diingat agar tidak diulang. */
    if (!tanpaThinking) {
      /* Nilai HURUF KECIL sesuai dokumentasi REST Google ("low", "minimal").
         Huruf besar berisiko diabaikan diam-diam sehingga model tetap
         berpikir penuh — gejalanya permintaan sepele memakan 25-30 detik. */
      cfg.thinkingConfig = (gaya === 'level')
        ? { thinkingLevel: level || LEVEL_URUT[0] }
        : { thinkingBudget: 0 };
    }
    if (!polos) {
      cfg.responseMimeType = 'application/json';
      if (opsi.skema) {
        /* v1beta memakai responseSchema; sebagian model baru memakai
           responseJsonSchema. Bila ditolak, panggilan berikutnya memakai
           nama alternatif, lalu akhirnya mode polos. */
        var namaSkema = (opsi.namaSkema === 'responseJsonSchema')
          ? 'responseJsonSchema' : 'responseSchema';
        cfg[namaSkema] = opsi.skema;
      }
    }

    var badan = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: cfg
    };
    if (opsi.systemInstruction) {
      badan.systemInstruction = { role: 'user', parts: [{ text: opsi.systemInstruction }] };
    }
    return JSON.stringify(badan);
  }

  /* ====================== PEMBACAAN JAWABAN ============================= */

  /** Ambil teks jawaban dari struktur balasan Gemini. */
  function _ambilTeks(mentah) {
    try {
      var j = JSON.parse(mentah);
      if (!j.candidates || !j.candidates.length) return '';
      var p = j.candidates[0].content;
      if (!p || !p.parts || !p.parts.length) return '';
      return p.parts.map(function (x) { return x.text || ''; }).join('');
    } catch (e) { return ''; }
  }

  /**
   * Apakah balasan terpotong karena kehabisan token?
   * finishReason MAX_TOKENS berarti model berhenti di tengah kalimat.
   */
  function _terpotong(mentah) {
    try {
      var j = JSON.parse(mentah);
      if (!j.candidates || !j.candidates.length) return false;
      return j.candidates[0].finishReason === 'MAX_TOKENS';
    } catch (e) { return false; }
  }

  function _finishReason(mentah) {
    try {
      var j = JSON.parse(mentah);
      return (j.candidates && j.candidates[0] && j.candidates[0].finishReason) || '';
    } catch (e) { return ''; }
  }

  /** Ambil pesan error asli dari balasan Google — jauh lebih berguna
      daripada nomor kode. Contoh: "Limit: 15 requests per day". */
  function _pesanError(mentah) {
    try {
      var j = JSON.parse(mentah);
      if (j && j.error && j.error.message) return String(j.error.message).slice(0, 300);
    } catch (e) {}
    return String(mentah || '').slice(0, 300);
  }

  /** Buang pagar ```json bila model menyertakannya. */
  function _bersihkanJson(teks) {
    var t = String(teks || '').trim().replace(/^\uFEFF/, '');
    if (t.indexOf('```') === 0) {
      t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
    }
    return t;
  }

  function parseJsonSafe(teks) {
    var t = _bersihkanJson(teks);
    if (!t) throw _err('AI_FORMAT', 'Jawaban AI kosong.');
    var parsed;
    try { parsed = JSON.parse(t); }
    catch (e) {
      /* kadang model menambah kalimat pembuka — ambil objek pertama */
      var a = t.indexOf('{'), b = t.lastIndexOf('}');
      if (a >= 0 && b > a) {
        try { parsed = JSON.parse(t.slice(a, b + 1)); } catch (e2) { parsed = null; }
      }
      if (!parsed) {
        var c = t.indexOf('['), d = t.lastIndexOf(']');
        if (c >= 0 && d > c) {
          try { parsed = { soal: JSON.parse(t.slice(c, d + 1)) }; } catch (e3) { parsed = null; }
        }
      }
      if (!parsed) {
        throw _err('AI_FORMAT', 'Jawaban AI tidak dapat dibaca sebagai JSON. Coba jalankan ulang.');
      }
    }
    return Array.isArray(parsed) ? { soal: parsed } : parsed;
  }

  /* ====================== PANGGILAN INTI (GEMINI) ======================= */

  /**
   * Panggil Gemini dengan rotasi key round-robin × fallback model.
   *
   * @param {string} prompt
   * @param {Object} opsi { skema, namaSkema, suhu, maksToken, systemInstruction,
   *                        thinking ('off'|'auto'|'low'|'minimal'|'high'),
   *                        deadline (ms epoch) }
   * @returns {{teks, key_index, model, durasi_ms, percobaan}}
   */
  function panggilGemini(prompt, opsi) {
    opsi = opsi || {};
    var keys = _keys('gemini');
    if (!keys.length) {
      throw _err('AI_BELUM_SIAP',
        'API key Gemini belum dipasang. Buka tab Pengaturan → tempel key (satu per baris) → Simpan.');
    }

    var model = _daftarModel();
    if (!model.length) {
      throw _err('AI_BELUM_SIAP', 'Tidak ada model AI yang tersedia. Coba lagi besok.');
    }

    var mulaiTotal = Date.now();
    var deadline = opsi.deadline || (mulaiTotal + BATAS_TOTAL_MS);
    var cursor = _cursor();
    var terakhirGagal = '';
    var adaYangDicoba = false;
    var percobaan = 0;

    /* Preferensi thinking dari guru:
         'off'  → matikan thinking (paling cepat & hemat kuota)
         'auto' → ikut adaptasi per model (level/budget)
         nilai lain ('low','minimal','medium','high') → paksa thinkingLevel itu */
    var mintaThink = String(opsi.thinking || 'off').toLowerCase();
    var paksaLevel = (mintaThink !== 'off' && mintaThink !== 'auto') ? mintaThink : '';

    /* Rotasi DUA sumbu: model di lapisan luar supaya seluruh key dicoba dulu
       pada model termurah sebelum berpindah model. */
    for (var m = 0; m < model.length; m++) {
      var modelIni = model[m];

      var polos = _modelTanpaSkema(modelIni);
      var tanpaThinking = (mintaThink === 'off') || _modelTanpaThink(modelIni);
      var gaya = _gayaThink(modelIni);
      var level = paksaLevel || _levelThink(modelIni);
      var namaSkema = 'responseSchema';
      var maksToken = opsi.maksToken || 8192;

      var muatan = _muatan(polos ? _promptPolos(prompt) : prompt,
        { skema: opsi.skema, namaSkema: namaSkema, suhu: opsi.suhu, maksToken: maksToken,
          systemInstruction: opsi.systemInstruction },
        polos, tanpaThinking, gaya, level);

      for (var putaran = 0; putaran < keys.length; putaran++) {

        if (Date.now() > deadline) {
          throw _err('AI_TIMEOUT',
            'Permintaan ke AI terlalu lama (' + percobaan + ' percobaan). Coba lagi sebentar, ' +
            'atau kurangi jumlah soal per generate.');
        }

        cursor = (cursor + 1) % keys.length;
        _simpanCursor(cursor);

        if (_keyRusak(cursor)) continue;
        if (_sedangCooldown(cursor, modelIni)) continue;

        adaYangDicoba = true;
        percobaan++;
        var mulai = Date.now();
        var resp;
        try {
          resp = UrlFetchApp.fetch(
            GEMINI_ENDPOINT + modelIni + ':generateContent?key=' + encodeURIComponent(keys[cursor]),
            {
              method: 'post',
              contentType: 'application/json',
              payload: muatan,
              muteHttpExceptions: true
            });
        } catch (e) {
          terakhirGagal = 'gangguan jaringan';
          _sleep(JEDA_SERVER);
          continue;
        }

        var kode = resp.getResponseCode();
        var isi = resp.getContentText();

        /* ---------- SUKSES ---------- */
        if (kode === 200) {
          var teks = _ambilTeks(isi);
          if (!teks) { terakhirGagal = 'balasan kosong'; continue; }

          /* Balasan terpotong TIDAK boleh dianggap sukses: diam-diam
             mengembalikan potongan membuat parseJson gagal dengan pesan
             menyesatkan, atau lebih buruk — soal tersimpan separuh jadi. */
          if (_terpotong(isi)) {
            terakhirGagal = 'jawaban ' + modelIni + ' terpotong (batas token)';
            if (!tanpaThinking) {
              /* Sudah mengirim thinkingConfig tetapi tetap terpotong —
                 mungkin medan itu diabaikan model. Coba tanpa medan tersebut
                 sambil memperbesar jatah token. */
              tanpaThinking = true;
              _tandaiTanpaThink(modelIni);
              maksToken = Math.min(32768, Math.round(maksToken * 1.6));
              muatan = _muatan(polos ? _promptPolos(prompt) : prompt,
                { skema: opsi.skema, namaSkema: namaSkema, suhu: opsi.suhu, maksToken: maksToken,
                  systemInstruction: opsi.systemInstruction },
                polos, true, gaya, level);
              putaran--;
              continue;
            }
            /* Sudah tanpa thinking pun terpotong → perbesar token sekali lagi */
            if (maksToken < 32768) {
              maksToken = Math.min(32768, Math.round(maksToken * 1.6));
              muatan = _muatan(polos ? _promptPolos(prompt) : prompt,
                { skema: opsi.skema, namaSkema: namaSkema, suhu: opsi.suhu, maksToken: maksToken,
                  systemInstruction: opsi.systemInstruction },
                polos, true, gaya, level);
              putaran--;
              continue;
            }
            _tandaiModelMati(modelIni);
            break;
          }

          _log('ai_sukses', {
            model: modelIni, key: 'key#' + cursor,
            durasi_ms: Date.now() - mulai, percobaan: percobaan, polos: polos
          });

          return {
            teks: teks,
            key_index: cursor,
            model: modelIni,
            durasi_ms: Date.now() - mulai,
            percobaan: percobaan,
            polos: polos,
            tanpaThinking: tanpaThinking
          };
        }

        var pesanAsli = _pesanError(isi);

        /* ---------- 429: KUOTA ---------- */
        if (kode === 429) {
          /* Bedakan kuota per-menit (pulih cepat) dari kuota harian (baru
             pulih tengah malam Pasifik). Menandai keduanya sama membuat
             sistem terus menabrak dinding yang sama. */
          var harian = /per day|perDay|GenerateRequestsPerDay|per 1 day/i.test(pesanAsli);
          _pasangCooldown(cursor, modelIni, harian ? CD_HARIAN : CD_MENIT,
            harian ? 'kuota-harian' : 'kuota-menit');
          terakhirGagal = harian
            ? 'kuota harian ' + modelIni + ' habis (key#' + cursor + ')'
            : 'terlalu banyak permintaan pada ' + modelIni + ' (key#' + cursor + ')';
          _sleep(300 + Math.floor(Math.random() * 500));   /* jitter */
          continue;
        }

        /* ---------- 404: MODEL TIDAK ADA ---------- */
        if (kode === 404) {
          _tandaiModelMati(modelIni);
          terakhirGagal = 'model ' + modelIni + ' tidak tersedia';
          break;                       /* langsung coba model berikutnya */
        }

        /* ---------- 400 / 401 / 403 ---------- */
        if (kode === 400 || kode === 401 || kode === 403) {
          /* 401 & 403 hampir selalu soal izin/key → perlakukan sebagai key
             bermasalah walau pesannya kosong.
             400 ambigu: sering berarti PROMPT yang salah, bukan key. Hanya
             naikkan jadi "key bermasalah" bila pesannya memang menyebut
             key/izin, supaya key sehat tidak ikut dihukum. */
          var soalKey = kode === 401 || kode === 403 ||
            /API key|API_KEY|permission|PERMISSION_DENIED|unregistered/i.test(pesanAsli);
          if (soalKey) {
            _pasangCooldownKey(cursor, CD_RUSAK, 'rusak');
            terakhirGagal = 'key#' + cursor + ' ditolak: ' + (pesanAsli || kode);
            continue;
          }

          /* --- keluhan seputar thinking ---
             Pola sengaja longgar: Google menulisnya dengan SPASI
             ("thinking budget"), bukan camelCase. */
          var soalThinking = /thinking[ _]?(config|budget|level)/i.test(pesanAsli) ||
            (!tanpaThinking &&
              /invalid value|allowed values|enum|not supported|unsupported/i.test(pesanAsli));

          if (soalThinking && mintaThink !== 'off') {
            /* Nilainya yang ditolak, bukan medannya → geser ke nilai berikut */
            var nilaiSalah = gaya === 'level' &&
              /invalid|not supported|unsupported|allowed values|enum/i.test(pesanAsli);
            if (nilaiSalah) {
              var ix = LEVEL_URUT.indexOf(level);
              if (ix >= 0 && ix < LEVEL_URUT.length - 1) {
                level = LEVEL_URUT[ix + 1];
                _tandaiLevel(modelIni, level);
                muatan = _muatan(polos ? _promptPolos(prompt) : prompt,
                  { skema: opsi.skema, namaSkema: namaSkema, suhu: opsi.suhu, maksToken: maksToken,
                    systemInstruction: opsi.systemInstruction },
                  polos, false, gaya, level);
                terakhirGagal = 'thinkingLevel disesuaikan ke ' + level;
                putaran--;
                continue;
              }
            }

            /* "only one of thinking budget and thinking level" → bentuk yang
               dikirim salah, bukan medannya tak dikenal. Tukar bentuknya. */
            var bentukSalah = /only one of/i.test(pesanAsli);
            if (bentukSalah && !tanpaThinking) {
              gaya = (gaya === 'level') ? 'budget' : 'level';
              _tandaiGaya(modelIni, gaya);
              muatan = _muatan(polos ? _promptPolos(prompt) : prompt,
                { skema: opsi.skema, namaSkema: namaSkema, suhu: opsi.suhu, maksToken: maksToken,
                  systemInstruction: opsi.systemInstruction },
                polos, false, gaya, level);
              terakhirGagal = 'bentuk thinkingConfig disesuaikan ke ' + gaya;
              putaran--;
              continue;
            }

            if (!tanpaThinking) {
              tanpaThinking = true;
              _tandaiTanpaThink(modelIni);
              muatan = _muatan(polos ? _promptPolos(prompt) : prompt,
                { skema: opsi.skema, namaSkema: namaSkema, suhu: opsi.suhu, maksToken: maksToken,
                  systemInstruction: opsi.systemInstruction },
                polos, true, gaya, level);
              terakhirGagal = 'model ' + modelIni + ' tidak mengenal thinkingConfig';
              putaran--;
              continue;
            }
          }

          /* --- keluhan seputar skema JSON --- */
          if (/responseSchema|response_schema|responseJsonSchema|responseMimeType|response_mime_type|Unknown name|not supported/i.test(pesanAsli)) {
            if (!polos && namaSkema === 'responseSchema') {
              /* coba dulu nama field alternatif (model Gemini 3 tertentu) */
              namaSkema = 'responseJsonSchema';
              muatan = _muatan(polos ? _promptPolos(prompt) : prompt,
                { skema: opsi.skema, namaSkema: namaSkema, suhu: opsi.suhu, maksToken: maksToken,
                  systemInstruction: opsi.systemInstruction },
                polos, tanpaThinking, gaya, level);
              terakhirGagal = 'mencoba responseJsonSchema pada ' + modelIni;
              putaran--;
              continue;
            }
            if (!polos) {
              /* coba sekali lagi TANPA skema, model yang sama. Diingat supaya
                 panggilan berikutnya langsung polos. */
              polos = true;
              _tandaiTanpaSkema(modelIni);
              muatan = _muatan(_promptPolos(prompt),
                { skema: null, suhu: opsi.suhu, maksToken: maksToken,
                  systemInstruction: opsi.systemInstruction },
                true, tanpaThinking, gaya, level);
              terakhirGagal = 'model ' + modelIni + ' tidak mendukung skema JSON';
              putaran--;                 /* ulangi key yang sama */
              continue;
            }
            /* sudah polos pun ditolak → model ini memang tidak cocok */
            _tandaiModelMati(modelIni);
            terakhirGagal = 'model ' + modelIni + ' menolak permintaan';
            break;
          }

          /* masalah pada permintaan itu sendiri (mis. prompt terlalu panjang)
             — mengulang ke key lain sia-sia */
          throw _err('AI_FORMAT',
            'Permintaan ditolak Gemini: ' + (pesanAsli || 'kode ' + kode));
        }

        /* ---------- 5xx: SERVER ---------- */
        if (kode >= 500) {
          terakhirGagal = 'server Gemini sedang bermasalah (kode ' + kode + ')';
          _sleep(JEDA_SERVER);
          continue;
        }

        terakhirGagal = pesanAsli || ('kode ' + kode);
      }
    }

    _cekKeyBermasalah();

    /* Pesan dibedakan: tidak ada yang sempat dicoba (semua masih istirahat)
       vs sudah dicoba tapi gagal. */
    if (!adaYangDicoba) {
      throw _err('SEMUA_KEY_HABIS',
        'Semua API key sedang istirahat karena kuota baru saja habis. ' +
        'Tunggu beberapa menit lalu coba lagi, atau susun soal manual.');
    }
    throw _err('SEMUA_KEY_HABIS',
      'Gagal menghubungi AI — ' + terakhirGagal + '. ' +
      'Coba lagi beberapa saat lagi, atau susun soal secara manual.');
  }

  /** Notifikasi internal bila banyak key bermasalah 24 jam. */
  function _cekKeyBermasalah() {
    try {
      var st = statusKeys('gemini');
      if (st.jml_bermasalah > 5) {
        _log('peringatan_key_ai', {
          bermasalah: st.jml_bermasalah, total: st.jml,
          pesan: 'Periksa tab Pengaturan → Status API Key.'
        });
      }
    } catch (e) {}
  }

  /* ====================== PANGGILAN OPENAI-COMPATIBLE =================== */

  function panggilOpenAi(prompt, opsi) {
    opsi = opsi || {};
    var keys = _keys('openai');
    if (!keys.length) {
      throw _err('AI_BELUM_SIAP', 'API key OpenAI belum dipasang (tab Pengaturan).');
    }
    var base = (_props().getProperty(PROP_BASE_URL) || OPENAI_BASE_DEFAULT).replace(/\/+$/, '');
    var model = _modelOpenAi();
    var mulaiTotal = Date.now();
    var deadline = opsi.deadline || (mulaiTotal + BATAS_TOTAL_MS);
    var cursor = _cursor();
    var terakhirGagal = '', percobaan = 0;

    var badan = {
      model: model,
      messages: (opsi.systemInstruction
        ? [{ role: 'system', content: opsi.systemInstruction }]
        : []).concat([{ role: 'user', content: prompt }]),
      temperature: opsi.suhu === undefined ? 0.7 : opsi.suhu,
      max_tokens: opsi.maksToken || 8192
    };
    if (opsi.skema) badan.response_format = { type: 'json_object' };

    for (var putaran = 0; putaran < keys.length; putaran++) {
      if (Date.now() > deadline) {
        throw _err('AI_TIMEOUT', 'Permintaan ke AI terlalu lama. Coba lagi sebentar.');
      }
      cursor = (cursor + 1) % keys.length;
      _simpanCursor(cursor);
      if (_keyRusak(cursor)) continue;
      percobaan++;
      var mulai = Date.now(), resp;
      try {
        resp = UrlFetchApp.fetch(base + '/chat/completions', {
          method: 'post', contentType: 'application/json',
          payload: JSON.stringify(badan), muteHttpExceptions: true
        });
      } catch (e) { terakhirGagal = 'gangguan jaringan'; _sleep(JEDA_SERVER); continue; }

      var kode = resp.getResponseCode();
      var isi = resp.getContentText();
      if (kode === 200) {
        var teks = '';
        try { teks = JSON.parse(isi).choices[0].message.content || ''; } catch (e2) {}
        if (!teks) { terakhirGagal = 'balasan kosong'; continue; }
        return { teks: teks, key_index: cursor, model: model, provider: 'openai',
                 durasi_ms: Date.now() - mulai, percobaan: percobaan };
      }
      var pesan = _pesanError(isi);
      if (kode === 401 || kode === 403) {
        _pasangCooldownKey(cursor, CD_RUSAK, 'rusak');
        terakhirGagal = 'key#' + cursor + ' ditolak: ' + pesan;
        continue;
      }
      if (kode === 429) {
        _pasangCooldown(cursor, model, /per day|daily/i.test(pesan) ? CD_HARIAN : CD_MENIT, 'kuota');
        terakhirGagal = 'kuota habis: ' + pesan;
        continue;
      }
      terakhirGagal = pesan || ('kode ' + kode);
      if (kode >= 500) _sleep(JEDA_SERVER);
    }
    throw _err('SEMUA_KEY_HABIS', 'Gagal menghubungi AI — ' + terakhirGagal);
  }

  /** Pemanggil umum: memilih provider sesuai Script Properties. */
  function panggil(prompt, opsi) {
    opsi = opsi || {};
    var provider = opsi.provider || _provider();
    if (provider === 'openai') {
      var r = panggilOpenAi(prompt, opsi);
      r.provider = 'openai';
      return r;
    }
    var g = panggilGemini(prompt, opsi);
    g.provider = 'gemini';
    return g;
  }

  /** Daftar model Gemini yang tersedia (mencoba key satu per satu). */
  function listGeminiModels() {
    var keys = _keys('gemini');
    if (!keys.length) return { ok: false, error: 'Belum ada API key Gemini.' };
    var terakhir = '';
    for (var i = 0; i < keys.length; i++) {
      try {
        var res = UrlFetchApp.fetch(
          'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(keys[i]),
          { method: 'get', muteHttpExceptions: true });
        if (res.getResponseCode() !== 200) { terakhir = _pesanError(res.getContentText()); continue; }
        var j = JSON.parse(res.getContentText());
        var nama = (j.models || [])
          .filter(function (m) { return /generateContent/.test(m.supportedGenerationMethods || []); })
          .map(function (m) { return String(m.name).replace('models/', ''); })
          .filter(function (n) { return n.indexOf('embedding') === -1; })
          .sort();
        return { ok: true, models: nama, key: 'key#' + i };
      } catch (e) { terakhir = e.message; }
    }
    return { ok: false, error: terakhir || 'Gagal mengambil daftar model.' };
  }

  /* ====================== PROMPT & SKEMA SOAL =========================== */

  function responseSchema_() {
    return {
      type: 'OBJECT',
      properties: {
        judul: { type: 'STRING', description: 'Usulan judul form/latihan, maksimal 80 karakter.' },
        deskripsi: { type: 'STRING', description: 'Deskripsi singkat latihan + petunjuk pengerjaan.' },
        stimulus: {
          type: 'STRING',
          description: 'Wacana bersama (opsional) jika beberapa soal memakai bacaan yang sama.'
        },
        soal: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              tipe: { type: 'STRING', description: 'pg | pg_kompleks | dropdown | isian | essay' },
              stimulus: {
                type: 'STRING',
                description: 'Hanya diisi jika guru minta soal wacana bersama. Kosongkan untuk soal mandiri (termasuk soal cerita/panjang).'
              },
              pakai_stimulus: { type: 'BOOLEAN', description: 'true hanya jika soal ini memakai wacana bersama.' },
              pertanyaan: {
                type: 'STRING',
                description: 'Teks soal. Soal mandiri: seluruh teks termasuk cerita panjang. Soal wacana: kalimat tanya saja.'
              },
              opsi: { type: 'ARRAY', items: { type: 'STRING' } },
              benar: { type: 'ARRAY', items: { type: 'INTEGER' }, description: 'Indeks 0-based jawaban benar.' },
              poin: { type: 'INTEGER' },
              level: { type: 'STRING', description: 'C1..C6' },
              pembahasan: { type: 'STRING' },
            },
            propertyOrdering: ['tipe', 'stimulus', 'pakai_stimulus', 'pertanyaan', 'opsi', 'benar', 'poin', 'level', 'pembahasan'],
            required: ['tipe', 'pertanyaan', 'benar']
          }
        }
      },
      propertyOrdering: ['judul', 'deskripsi', 'stimulus', 'soal'],
      required: ['soal']
    };
  }

  function buildSystemInstruction_(spec) {
    var lang = spec.bahasa === 'en' ? 'English' : 'Bahasa Indonesia';
    return [
      'Anda adalah guru dan penulis soal asesmen profesional yang berpengalaman membuat soal HOTS,',
      'soal AKM/ANBK, dan soal ujian sekolah. Tugas Anda menghasilkan soal yang valid, tidak ambigu,',
      'satu kunci jawaban yang pasti benar, dan pengecoh (distractor) yang masuk akal.',
      '',
      'ATURAN WAJIB:',
      '1. Bahasa keluaran: ' + lang + '.',
      '2. Keluarkan HANYA JSON sesuai skema. Tanpa markdown, tanpa code fence, tanpa komentar.',
      '3. Setiap soal harus MANDIRI dan BISA DIJAWAB hanya dari teks di JSON (stimulus + pertanyaan + opsi).',
      '   Dilarang merujuk soal lain.',
      '4. Google Form HANYA menampilkan teks. DILARANG soal yang mengandalkan media yang tidak bisa',
      '   ditulis: paparan lisan, rekaman audio, podcast, video, gambar, foto, peta, diagram, infografis.',
      '   Jangan memakai frasa seperti "Berdasarkan paparan lisan tersebut", "simak rekaman",',
      '   "dengarkan", "perhatikan gambar di atas", "lihat video".',
      '   Jika butuh pidato/wawancara/siaran: TULISKAN transkripnya sebagai wacana teks',
      '   (label "Cuplikan paparan:" / "Dialog:" / "Pengumuman:").',
      '   Jika butuh data/tabel: tulis tabel teks atau daftar angka, bukan "lihat tabel berikut" kosong.',
      '5. Paparan, soal cerita, wacana, dialog, data, atau tabel TARUH di medan "stimulus".',
      '   Medan "pertanyaan" HANYA berisi kalimat tanya — jangan menyalin wacana ke pertanyaan.',
      '   Jika beberapa soal memakai wacana yang sama, isi "stimulus" yang sama pada soal-soal itu',
      '   ATAU isi "stimulus" tingkat atas + "pakai_stimulus": true pada soal yang memakai wacana.',
      '   Soal mandiri: stimulus kosong dan pakai_stimulus false.',
      '6. Frasa "tersebut / di atas / berikut" HANYA boleh dipakai jika teks acuannya ada di "stimulus".',
      '7. Untuk tipe pg/dropdown: tepat 4 atau 5 opsi, HANYA SATU jawaban benar.',
      '8. Untuk tipe pg_kompleks: 4-6 opsi, minimal 2 dan maksimal 3 jawaban benar.',
      '9. Untuk tipe isian: jawaban singkat 1-3 kata; "benar" berisi 1 kemungkinan jawaban.',
      '10. Untuk tipe essay: "opsi" kosong, "benar" berisi poin-poin kunci jawaban (1 string).',
      '11. Indeks pada "benar" adalah 0-based dan HARUS valid terhadap panjang "opsi".',
      '12. Jangan membuat opsi seperti "Semua jawaban benar" / "A dan B benar".',
      '13. "pembahasan" ringkas 1-3 kalimat: konsep yang diuji & mengapa opsi lain salah.',
      '14. Sebar level kognitif sesuai permintaan dan hindari pengulangan konsep yang sama.'
    ].join('\n');
  }

  function ringkasWacana_(spec) {
    spec = spec || {};
    var grup = [];
    var raw = spec.wacanaGrup;
    if (Array.isArray(raw)) {
      raw.forEach(function (g) {
        var n = Number(g && (g.jumlah != null ? g.jumlah : g));
        if (isFinite(n) && n >= 1) grup.push(Math.min(20, Math.round(n)));
      });
    }
    var mandiri = Number(spec.jumlahMandiri != null ? spec.jumlahMandiri : spec.jumlah) || 0;
    if (mandiri < 0) mandiri = 0;
    var extra = 0;
    grup.forEach(function (x) { extra += x; });
    var total = mandiri + extra;
    if (total < 1) total = Math.max(1, Number(spec.jumlah) || 10);
    return { mandiri: mandiri, grup: grup, total: total };
  }

  function buildPrompt_(spec) {
    var ringkas = ringkasWacana_(spec);
    var n = ringkas.total;
    var tipeList = (spec.tipe && spec.tipe.length ? spec.tipe : ['pg']).join(', ');
    var levelList = (spec.level && spec.level.length ? spec.level : ['C3', 'C4']).join(', ');
    var komposisi = {
      mudah: '70% mudah, 20% sedang, 10% sulit',
      sedang: '20% mudah, 60% sedang, 20% sulit',
      sulit: '10% mudah, 20% sulit, 70% sedang',
      campuran: 'seimbang antara mudah, sedang, dan sulit'
    }[spec.kesulitan] || 'seimbang antara mudah, sedang, dan sulit';

    var lines = [
      'Buatkan ' + n + ' soal dengan rincian berikut.',
      '',
      'Mata pelajaran   : ' + (spec.mapel || '-'),
      'Kelas / jenjang  : ' + (spec.kelas || '-'),
      'Kurikulum        : ' + (spec.kurikulum || 'Kurikulum Merdeka'),
      'Topik / materi   : ' + (spec.topik || '-'),
      'Tipe soal        : ' + tipeList + ' (patuhi proporsi bila lebih dari satu tipe)',
      'Level kognitif   : ' + levelList,
      'Tingkat kesulitan: ' + spec.kesulitan + ' → komposisi: ' + komposisi,
      'Poin per soal    : ' + (spec.poin || 1),
      'Bahasa           : ' + (spec.bahasa === 'en' ? 'English' : 'Bahasa Indonesia'),
      'Pembahasan       : ' + (spec.pembahasan === false ? 'tetap isi singkat' : 'wajib ada'),
      'Gaya/preset      : ' + (spec.preset || 'umum')
    ];

    if (spec.cpTp) lines.push('Capaian Pembelajaran / TP : ' + spec.cpTp);
    if (spec.indikator) lines.push('Indikator soal : ' + spec.indikator);
    if (spec.instruksi) lines.push('Instruksi tambahan dari guru: ' + spec.instruksi);
    if (spec.materi) {
      var m = String(spec.materi);
      if (m.length > 6000) m = m.substring(0, 6000) + ' …(dipotong)';
      lines.push('', 'MATERI ACUAN (buat soal HANYA berdasarkan materi ini):', '"""', m, '"""');
    }
    if (spec.preset === 'akm') {
      lines.push('', 'Catatan gaya AKM: konteks kehidupan nyata, literasi/numerasi — bukan hafalan.',
        'DILARANG merujuk audio/gambar/video. Jika butuh transkrip/data, tulis teksnya di "pertanyaan"',
        '(soal mandiri) atau di "stimulus" (hanya jika guru minta soal wacana bersama).');
    }
    if (ringkas.grup.length) {
      lines.push('', 'KOMPOSISI WACANA (wajib dipatuhi, urutan soal sesuai nomor):');
      var mulai = 1;
      if (ringkas.mandiri > 0) {
        lines.push('- Soal ' + mulai + '–' + (mulai + ringkas.mandiri - 1) +
          ': MANDIRI. Seluruh teks (termasuk cerita panjang) di "pertanyaan". "stimulus" KOSONG.');
        mulai += ringkas.mandiri;
      }
      ringkas.grup.forEach(function (jml, i) {
        var a = mulai, b = mulai + jml - 1;
        lines.push('- Soal ' + a + (a === b ? '' : '–' + b) +
          ': SATU wacana bersama (wacana ' + (i + 1) + '). Isi "stimulus" yang SAMA pada soal-soal ini;',
          '  "pertanyaan" hanya kalimat tanya yang merujuk wacana itu. Jangan salin wacana ke pertanyaan.');
        mulai += jml;
      });
    } else {
      lines.push('',
        'SEMUA soal mandiri. JANGAN isi medan "stimulus".',
        'Soal cerita/panjang tetap SATU teks utuh di "pertanyaan" — jangan dipisah ke wacana/stimulus.',
        'Jangan merujuk paparan/gambar/rekaman yang tidak tertulis di dalam pertanyaan.');
    }
    if (spec.preset === 'uts' || spec.preset === 'uas') {
      lines.push('', 'Catatan gaya ujian sekolah: soal formal, berurutan dari mudah ke sulit,',
        'cakupan materi luas.');
    }
    lines.push('', 'Hasilkan JSON sekarang.');
    return lines.join('\n');
  }

  /* ====================== API PUBLIK: GENERATE SOAL ===================== */

  /** Menghasilkan daftar soal dari spesifikasi guru. */
  function generateQuestions(spec) {
    spec = spec || {};
    var ringkas = ringkasWacana_(spec);
    spec.jumlah = ringkas.total;
    spec.jumlahMandiri = ringkas.mandiri;
    spec.wacanaGrup = ringkas.grup.map(function (j) { return { jumlah: j }; });
    var mulai = Date.now();
    var deadline = mulai + BATAS_TOTAL_MS;
    var percobaanParse = 0, lastErr = null;

    while (percobaanParse < 2) {
      percobaanParse++;
      var prompt = buildPrompt_(spec);
      if (percobaanParse > 1) {
        prompt += '\n\nPERBAIKAN: percobaan sebelumnya gagal (' + lastErr +
          '). Ulangi dengan JSON yang valid dan lengkap.';
      }

      var hasil;
      try {
        hasil = panggil(prompt, {
          skema: responseSchema_(),
          suhu: typeof spec.temperature === 'number' ? spec.temperature : 0.8,
          maksToken: Math.min(32768, 4096 + Number(spec.jumlah || 10) * 900),
          systemInstruction: buildSystemInstruction_(spec),
          thinking: spec.thinking || 'off',
          deadline: deadline
        });
      } catch (e) {
        /* Error dari lapisan rotasi sudah final (semua key/model dicoba). */
        e.message = 'Gagal membuat soal. ' + e.message;
        throw e;
      }

      try {
        var data = parseJsonSafe(hasil.teks);
        var questions = normalize_(data, spec);
        if (!questions.length) throw _err('AI_FORMAT', 'Model tidak menghasilkan soal apa pun.');
        return {
          questions: questions,
          meta: {
            model: hasil.model,
            provider: hasil.provider || 'gemini',
            key: 'key#' + hasil.key_index,
            keyIndex: hasil.key_index,
            elapsedMs: hasil.durasi_ms,
            totalMs: Date.now() - mulai,
            percobaan: hasil.percobaan,
            polos: !!hasil.polos,
            judul: data.judul || '',
            deskripsi: data.deskripsi || '',
            stimulus: data.stimulus || ''
          }
        };
      } catch (errParse) {
        lastErr = errParse.message;
        if (Date.now() > deadline) break;
      }
    }
    throw _err('AI_FORMAT', 'Gagal membuat soal: jawaban AI tidak dapat dibaca. ' + (lastErr || ''));
  }

  /** Mengganti satu soal tertentu tanpa mengulang semuanya. */
  function regenerateQuestion(spec, index, existing) {
    var tipeList = (spec.tipe && spec.tipe.length ? spec.tipe : ['pg']).join(', ');
    var hindari = (existing || []).map(function (q, i) {
      return (i + 1) + '. ' + String(q.pertanyaan || q.text || '').substring(0, 120);
    }).join('\n');

    var prompt = [
      'Buat SATU soal baru (pengganti soal nomor ' + (Number(index) + 1) + ') dengan spesifikasi:',
      'Mapel: ' + (spec.mapel || '-'),
      'Kelas: ' + (spec.kelas || '-'),
      'Topik: ' + (spec.topik || '-'),
      'Tipe soal: ' + tipeList,
      'Level kognitif: ' + ((spec.level && spec.level.length) ? spec.level.join(', ') : 'C4'),
      'Poin: ' + (spec.poin || 1),
      'Bahasa: ' + (spec.bahasa === 'en' ? 'English' : 'Bahasa Indonesia'),
      spec.materi ? 'Acuan materi:\n"""' + String(spec.materi).substring(0, 4000) + '"""' : '',
      hindari ? 'Soal-soal yang SUDAH ada (JANGAN diulang/diserupai):\n' + hindari : '',
      spec.instruksi ? 'Instruksi tambahan: ' + spec.instruksi : '',
      '',
      'Soal mandiri: seluruh teks di "pertanyaan", stimulus kosong. Jangan pecah soal panjang ke wacana.',
      'Dilarang merujuk paparan lisan/gambar/rekaman yang tidak tertulis.',
      '',
      'Keluarkan JSON: {"soal":[ {satu objek soal} ]}'
    ].filter(Boolean).join('\n');

    var hasil = panggil(prompt, {
      skema: responseSchema_(),
      suhu: 0.95,
      maksToken: 4096,
      systemInstruction: buildSystemInstruction_(spec),
      thinking: spec.thinking || 'off'
    });
    var arr = normalize_(parseJsonSafe(hasil.teks), spec);
    if (!arr.length) throw _err('AI_FORMAT', 'Model tidak menghasilkan soal pengganti.');
    arr[0].meta = { model: hasil.model, key: 'key#' + hasil.key_index };
    return arr[0];
  }

  /* ====================== NORMALISASI SOAL ============================== */

  var TIPE_ALIAS = {
    'pg': 'pg', 'pilihan ganda': 'pg', 'pilihan_ganda': 'pg', 'multiple_choice': 'pg',
    'multiplechoice': 'pg', 'multiple choice': 'pg', 'mc': 'pg', 'single': 'pg',
    'pg_kompleks': 'pg_kompleks', 'pg kompleks': 'pg_kompleks', 'pgkompleks': 'pg_kompleks',
    'multiple_answers': 'pg_kompleks', 'multiple answers': 'pg_kompleks', 'checkbox': 'pg_kompleks',
    'check box': 'pg_kompleks', 'complex_multiple_choice': 'pg_kompleks',
    'benar_salah': 'benar_salah', 'benar salah': 'benar_salah', 'true_false': 'benar_salah',
    'dropdown': 'dropdown', 'drop_down': 'dropdown', 'drop down': 'dropdown', 'list': 'dropdown',
    'isian': 'isian', 'isian singkat': 'isian', 'isian_singkat': 'isian', 'short answer': 'isian',
    'short_answer': 'isian', 'isiansingkat': 'isian', 'jawaban singkat': 'isian', 'fill in': 'isian',
    'essay': 'essay', 'esai': 'essay', 'uraian': 'essay', 'paragraph': 'essay', 'long answer': 'essay'
  };

  function normalizeTipe_(v, opsiLen) {
    var key = String(v || '').toLowerCase().trim().replace(/[\s_\-]+/g, ' ');
    var t = TIPE_ALIAS[key] || '';
    if (!t) {
      if (key.indexOf('kompleks') >= 0 || key.indexOf('multiple answer') >= 0 || key.indexOf('check box') >= 0) t = 'pg_kompleks';
      else if (key.indexOf('benar') >= 0 && key.indexOf('salah') >= 0) t = 'benar_salah';
      else if (key.indexOf('isian') >= 0 || key.indexOf('short answer') >= 0 || key.indexOf('jawaban singkat') >= 0) t = 'isian';
      else if (key.indexOf('essay') >= 0 || key.indexOf('esai') >= 0 || key.indexOf('uraian') >= 0 || key.indexOf('paragraph') >= 0) t = 'essay';
      else if (key.indexOf('drop') >= 0) t = 'dropdown';
      else if (key.indexOf('pilihan') >= 0 || key.indexOf('choice') >= 0) t = 'pg';
    }
    if (!t) t = opsiLen > 0 ? 'pg' : 'essay';
    if ((t === 'pg' || t === 'pg_kompleks' || t === 'dropdown' || t === 'benar_salah') && opsiLen === 0) t = 'essay';
    return t;
  }

  /**
   * Mengubah kunci jawaban dari model (angka 0-based / 1-based / huruf A-J /
   * teks opsi) menjadi array indeks 0-based yang valid.
   */
  function toIndexArray_(benar, options) {
    var len = options.length;
    if (benar === null || typeof benar === 'undefined' || len === 0) return [];

    var raw = Array.isArray(benar) ? benar : [benar];
    var cand = [], numeric = 0;

    raw.forEach(function (b) {
      if (b === null || typeof b === 'undefined' || b === '') return;
      if (typeof b === 'number' && isFinite(b)) { cand.push(Math.round(b)); numeric++; return; }
      var s = String(b).trim();
      if (!s) return;
      var up = s.toUpperCase();
      if (/^\d+$/.test(s)) { cand.push(parseInt(s, 10)); numeric++; return; }
      if (/^[A-J]$/.test(up)) { cand.push(up.charCodeAt(0) - 65); return; }  // huruf = 0-based
      var low = s.toLowerCase();                                            // teks opsi = 0-based
      for (var i = 0; i < len; i++) {
        var o = String(options[i] || '').toLowerCase();
        if (o === low || o.indexOf(low) === 0 || low.indexOf(o) === 0) { cand.push(i); return; }
      }
    });

    /* Deteksi penomoran 1-based: ada indeks yang mencapai/melewati jumlah
       opsi, atau beberapa kunci angka tanpa satu pun bernilai 0 dan salah
       satunya menyentuh opsi terakhir. */
    var oneBased = false;
    if (numeric > 0 && cand.length) {
      var maxIdx = Math.max.apply(null, cand);
      if (maxIdx >= len) oneBased = true;
      else if (numeric > 1 && cand.indexOf(0) === -1 && maxIdx === len - 1) oneBased = true;
    }
    if (oneBased) cand = cand.map(function (x) { return x - 1; });

    var out = [];
    cand.forEach(function (x) {
      if (x >= 0 && x < len && out.indexOf(x) === -1) out.push(x);
    });
    return out;
  }

  /** Soal merujuk acuan ("tersebut/di atas/berikut", paparan, gambar, rekaman). */
  function merujukAcuan_(text) {
    return /(paparan lisan|rekaman|podcast|menyimak|dengarkan|perhatikan gambar|lihat gambar|cuplikan (video|audio)|berdasarkan .{0,60}(tersebut|di atas|berikut)|perhatikan .{0,40}(tersebut|di atas|berikut)|wacana (tersebut|di atas|berikut)|bacaan (tersebut|di atas|berikut)|tabel (tersebut|di atas|berikut)|data (tersebut|di atas|berikut)|teks (tersebut|di atas|berikut)|gambar (tersebut|di atas|berikut)|diagram (tersebut|di atas|berikut)|peta (tersebut|di atas|berikut)|the (passage|text|table|figure|recording|audio|video) (above|below))/i
      .test(String(text || ''));
  }

  /** Merujuk media yang tidak bisa ditampilkan Google Form. */
  function merujukMediaNonTeks_(text) {
    return /(paparan lisan|rekaman( audio)?|podcast|siaran radio|menyimak|dengarkan|listen(ing)?|cuplikan (video|audio)|perhatikan gambar|lihat gambar|gambar (tersebut|di atas|berikut)|film pendek|peta (tersebut|di atas)|diagram (tersebut|di atas))/i
      .test(String(text || ''));
  }

  /** Pertanyaan sudah memuat wacana sendiri (paragraf sebelum kalimat tanya). */
  function punyaWacanaSendiri_(text) {
    var t = String(text || '').trim();
    var blocks = t.split(/\n\s*\n/);
    if (blocks.length >= 2 && blocks[0].replace(/\s+/g, ' ').length >= 80) return true;
    return t.length >= 280 && /\n/.test(t);
  }

  /** Ubah escape JSON (`\\n`) jadi baris baru sungguhan. */
  function bukaBarisBaru_(s) {
    return String(s == null ? '' : s)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\n');
  }

  /** Gabungkan wacana + pertanyaan, tanpa menduplikasi bila sudah tertanam. */
  function gabungStimulus_(stimulus, text) {
    var stim = String(stimulus || '').trim();
    var t = String(text || '').trim();
    if (!stim) return t;
    if (!t) return stim;
    if (t.indexOf(stim) !== -1) return t;
    return stim + '\n\n' + t;
  }


  /* ====================== PENYISIPAN WACANA ============================ */

  var LABEL_WACANA = 'Bacalah teks berikut untuk menjawab soal.';

  function _ringkasSpasi_(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Stimulus TETAP terpisah dari text (UI + Form judul/deskripsi).
   * Tidak menggabungkan ke text.
   */
  function sisipkanStimulus_(list) {
    return list;
  }

  /** Ambil wacana yang terselip di awal pertanyaan (paragraf + baris kosong). */
  function pecahWacanaDariTeks_(text, stimulus) {
    var full = String(text || '').replace(/\r\n/g, '\n').trim();
    var stim = String(stimulus || '').replace(/\r\n/g, '\n').trim();
    if (stim && full.indexOf(stim) === 0) {
      return { wacana: stim, stem: full.substring(stim.length).replace(/^\s+/, '') };
    }
    if (stim && full.indexOf(stim) !== -1) {
      return { wacana: stim, stem: full.split(stim).join('\n').replace(/^\s+/, '').trim() || full };
    }
    /* Soal panjang tetap 1 soal — jangan pecah paragraf jadi wacana. */
    return { wacana: stim, stem: full };
  }

  /**
   * Membersihkan objek mentah dari model menjadi struktur baku FormBuilder.
   * Keluaran per soal: {type,text,options,correctIdx,points,level,explanation,stimulus}
   */
  function normalize_(data, spec) {
    var list = [];
    if (!data) return list;
    if (Array.isArray(data)) list = data;
    else if (Array.isArray(data.soal)) list = data.soal;
    else if (Array.isArray(data.questions)) list = data.questions;
    else if (Array.isArray(data.items)) list = data.items;
    else if (data.soal && typeof data.soal === 'object') list = [data.soal];
    else if (data.question) list = [data.question];

    var defaultPoints = Number(spec && spec.poin ? spec.poin : 1) || 1;
    var stimulusGlobal = bukaBarisBaru_(data.stimulus || '').trim();

    var hasil = list.map(function (q, i) {
      q = q || {};
      var text = bukaBarisBaru_(q.pertanyaan || q.question || q.text || q.soal || '').trim();

      var opsiRaw = q.opsi || q.options || q.pilihan || [];
      if (!Array.isArray(opsiRaw)) opsiRaw = [];
      var options = opsiRaw.map(function (o) {
        if (o && typeof o === 'object') return String(o.text || o.value || o.label || '').trim();
        return String(o).trim();
      }).filter(function (o) { return o.length > 0; });

      var benarRaw = (typeof q.benar !== 'undefined') ? q.benar :
        (typeof q.kunci !== 'undefined' ? q.kunci :
          (typeof q.correct !== 'undefined' ? q.correct : q.answer));
      var correctIdx = toIndexArray_(benarRaw, options);

      /* fallback: cocokkan teks jawaban dengan opsi */
      if (!correctIdx.length && options.length) {
        var jawabanTeks = String(q.jawaban || q.answerText || '').trim().toLowerCase();
        if (jawabanTeks) {
          options.forEach(function (o, oi) { if (o.toLowerCase() === jawabanTeks) correctIdx.push(oi); });
        }
      }

      var type = normalizeTipe_(q.tipe || q.type || q.jenis, options.length);

      /* Kunci berbentuk TEKS (bukan indeks) untuk isian singkat & essay. */
      var rawArr = Array.isArray(benarRaw) ? benarRaw : [benarRaw];
      var answerText = '';
      if (type === 'isian' || type === 'essay') {
        answerText = rawArr.map(function (x) {
          return (x === null || typeof x === 'undefined') ? '' : String(x).trim();
        }).filter(function (x) { return x.length; }).join('\n');
        if (!answerText && options.length && correctIdx.length) answerText = options[correctIdx[0]];
        if (!answerText) answerText = String(q.jawaban || q.answer || q.answerText || '').trim();
        if (!options.length && answerText) options = [answerText];
      }

      /* benar_salah (adaptasi LessonLen): dipetakan jadi PG 2 opsi supaya
         langsung bisa masuk Google Form tanpa kehilangan makna. */
      if (type === 'benar_salah') {
        if (options.length !== 2) options = ['Benar', 'Salah'];
        var k = String(benarRaw || '').toLowerCase();
        correctIdx = [/^(s|salah|false|0|tidak benar|keliru)$/i.test(k) ? 1 : 0];
        answerText = '';
        type = 'pg';
      }

      /* perbaiki tipe berdasar jumlah kunci */
      if (type === 'pg' && correctIdx.length > 1) type = 'pg_kompleks';
      if (type === 'pg_kompleks' && correctIdx.length === 1 && options.length) type = 'pg';
      if ((type === 'pg' || type === 'pg_kompleks' || type === 'dropdown') && !correctIdx.length) {
        correctIdx = [0];   /* aman: guru tetap bisa mengoreksi di pratinjau */
      }
      if (type === 'pg_kompleks' && correctIdx.length < 2 && options.length > 2) {
        correctIdx.push((correctIdx[0] + 1) % options.length);
      }

      var points = Number(q.poin || q.points || q.bobot || defaultPoints);
      if (!isFinite(points) || points <= 0) points = defaultPoints;

      /* Stimulus tetap terpisah. Jika wacana terselip di pertanyaan, dipisah. */
      var merujuk = merujukAcuan_(text);
      var sisa = bukaBarisBaru_(q.stimulus || q.wacana || '').trim();
      if (!sisa && stimulusGlobal && (q.pakai_stimulus === true || merujuk)) sisa = stimulusGlobal;
      var pecah = pecahWacanaDariTeks_(text, sisa);
      if (pecah.wacana) sisa = pecah.wacana;
      if (pecah.stem) text = pecah.stem;

      var warning = '';
      if (!text) warning = 'Teks soal kosong dari AI';
      else if (merujukMediaNonTeks_(text) && !sisa && !punyaWacanaSendiri_(text)) {
        warning = 'Soal merujuk paparan/gambar/rekaman yang tidak ada di dalam teks soal';
      } else if (merujukAcuan_(text) && !sisa && !punyaWacanaSendiri_(text)) {
        warning = 'Soal merujuk wacana/cerita yang tidak ada di dalam teks soal';
      }

      return {
        n: i + 1,
        type: type,
        text: text || ('Soal ' + (i + 1)),
        options: options,
        correctIdx: correctIdx,
        points: points,
        level: String(q.level || q.tingkat || q.kognitif || q.cognitiveLevel || '').trim(),
        explanation: String(q.pembahasan || q.explanation || q.feedback || q.alasan || '').trim(),
        answerText: answerText,
        stimulus: sisa,
        pakaiStimulus: !!sisa || q.pakai_stimulus === true,
        warning: warning
      };
    });

    hasil = hasil.filter(function (q) { return q.text && q.text.length > 1; });
    var plan = ringkasWacana_(spec);
    if (plan.grup.length) {
      hasil.forEach(function (item, i) {
        if (i < plan.mandiri) {
          if (item.stimulus) item.text = gabungStimulus_(item.stimulus, item.text);
          item.stimulus = '';
          item.pakaiStimulus = false;
        }
      });
      var cursor = plan.mandiri;
      plan.grup.forEach(function (jml) {
        var first = '', k;
        for (k = cursor; k < cursor + jml && k < hasil.length; k++) {
          if (hasil[k].stimulus) { first = hasil[k].stimulus; break; }
        }
        for (k = cursor; k < cursor + jml && k < hasil.length; k++) {
          if (first) {
            if (!hasil[k].stimulus) hasil[k].stimulus = first;
            hasil[k].pakaiStimulus = true;
          }
        }
        cursor += jml;
      });
    }
    hasil.forEach(function (q, i) { q.n = i + 1; });
    return hasil;
  }

  /* ====================== TABEL MARKDOWN → HTML ========================= */

  /**
   * Ubah tabel Markdown jadi <table> HTML (adaptasi LessonLen v1.5.6).
   * Prompt sudah meminta HTML, tetapi model KERAP tetap membalas bergaya
   * Markdown — bentuk yang paling sering dilatihkan padanya. Berguna untuk
   * merapikan medan `stimulus` sebelum ditampilkan/ditempel ke Form.
   */
  function tabelMarkdownKeHtml(teks) {
    var baris = String(teks || '').split('\n');
    var keluar = [];
    var i = 0;

    function selTabel(b) {
      var t = b.trim();
      return t.indexOf('|') > -1 && /^\|?[^|]*\|/.test(t);
    }
    function pisah(b) {
      var t = b.trim().replace(/^\|/, '').replace(/\|$/, '');
      return t.split('|').map(function (x) { return x.trim(); });
    }
    function barisPemisah(b) {
      return /^\|?[\s:|-]+\|[\s:|-]*$/.test(b.trim()) && b.indexOf('-') > -1;
    }
    function esc(s) {
      return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    while (i < baris.length) {
      if (selTabel(baris[i]) && i + 1 < baris.length && barisPemisah(baris[i + 1])) {
        var kepala = pisah(baris[i]);
        i += 2;
        var isi = [];
        while (i < baris.length && selTabel(baris[i]) && !barisPemisah(baris[i])) {
          isi.push(pisah(baris[i])); i++;
        }
        var html = '<table><thead><tr>' +
          kepala.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
          '</tr></thead><tbody>' +
          isi.map(function (r) {
            var sel = r.slice(0, kepala.length);
            while (sel.length < kepala.length) sel.push('');
            return '<tr>' + sel.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>';
          }).join('') + '</tbody></table>';
        keluar.push(html);
        continue;
      }
      keluar.push(baris[i]);
      i++;
    }
    return keluar.join('\n');
  }

  /* ====================== EKSPOR ======================================== */

  return {
    /* generator */
    generateQuestions: generateQuestions,
    regenerateQuestion: regenerateQuestion,

    /* lapisan panggilan */
    panggil: panggil,
    panggilGemini: panggilGemini,
    panggilOpenAi: panggilOpenAi,

    /* manajemen key & model (dipakai Code.gs / UI) */
    simpanKeys: simpanKeys,
    statusKeys: statusKeys,
    simpanModel: simpanModel,
    resetCooldown: resetCooldown,
    listGeminiModels: listGeminiModels,
    cacheError: cacheError,

    /* prompt & parsing (dipakai FormBuilder & uji) */
    buildPrompt_: buildPrompt_,
    buildSystemInstruction_: buildSystemInstruction_,
    responseSchema_: responseSchema_,
    parseJsonSafe: parseJsonSafe,
    parseJsonSafe_: parseJsonSafe,
    normalize_: normalize_,
    sisipkanStimulus_: sisipkanStimulus_,
    toIndexArray_: toIndexArray_,
    gabungStimulus_: gabungStimulus_,
    tabelMarkdownKeHtml: tabelMarkdownKeHtml,

    /* diagnostik */
    _ambilTeks: _ambilTeks,
    _terpotong: _terpotong,
    _pesanError: _pesanError,
    _bersihkanJson: _bersihkanJson,
    _daftarModel: _daftarModel,
    _keys: _keys,
    _gayaThink: _gayaThink,
    _levelThink: _levelThink,
    _muatan: _muatan,
    _err: _err,

    MODEL: MODEL,
    MODEL_BAWAAN: MODEL_BAWAAN,
    BATAS_TOTAL_MS: BATAS_TOTAL_MS
  };
})();
 tabelMarkdownKeHtml: tabelMarkdownKeHtml,

    /* diagnostik */
    _ambilTeks: _ambilTeks,
    _terpotong: _terpotong,
    _pesanError: _pesanError,
    _bersihkanJson: _bersihkanJson,
    _daftarModel: _daftarModel,
    _keys: _keys,
    _gayaThink: _gayaThink,
    _levelThink: _levelThink,
    _muatan: _muatan,
    _err: _err,

    MODEL: MODEL,
    MODEL_BAWAAN: MODEL_BAWAAN,
    BATAS_TOTAL_MS: BATAS_TOTAL_MS
  };
})();
