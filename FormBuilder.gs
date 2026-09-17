/**
 * ============================================================================
 *  FormBuilder.gs — Mengubah daftar soal (hasil AI / hasil edit) jadi
 *                   Google Form + Spreadsheet Kunci Jawaban
 * ============================================================================
 *  Tipe soal yang didukung:
 *    pg            → MultipleChoiceItem  (satu jawaban, auto-acak posisi benar)
 *    pg_kompleks   → CheckboxItem        (banyak jawaban benar)
 *    dropdown      → ListItem
 *    isian         → TextItem + validasi teks (kunci = teks persis)
 *    essay         → ParagraphTextItem   (tanpa nilai otomatis)
 *
 *  Ekstra: mode Kuis (poin + umpan balik), section header, acak urutan soal,
 *  wajib login, batasi 1 respons, folder Drive khusus, spreadsheet kunci.
 * ============================================================================
 */

var FormBuilder = (function () {

  var LABEL_TIPE = {
    pg: 'Pilihan Ganda',
    pg_kompleks: 'PG Kompleks (Jawaban Ganda)',
    dropdown: 'Dropdown',
    isian: 'Isian Singkat',
    essay: 'Essay / Uraian'
  };

  /* ====================== FOLDER DRIVE ================================== */

  /**
   * Menentukan folder tujuan. Terima ID folder, URL folder, atau kosong
   * (⇒ pakai/buat folder "Soal AI" di root Drive).
   */
  function resolveFolder_(folderRef) {
    var ref = String(folderRef || '').trim();
    if (ref) {
      var id = ref.indexOf('/') >= 0 ? extractId_(ref) : ref;
      try {
        return DriveApp.getFolderById(id);
      } catch (err) {
        throw new Error('Folder Drive tidak ditemukan: ' + ref + '. ' + err.message);
      }
    }
    var name = 'Soal AI';
    var it = DriveApp.getFoldersByName(name);
    if (it.hasNext()) return it.next();
    return DriveApp.createFolder(name);
  }

  /** Mengambil ID dari URL Drive (form/folder/spreadsheet). */
  function extractId_(url) {
    var m = String(url).match(/[-\w]{25,}/);
    return m ? m[0] : String(url);
  }

  /* ====================== UTIL SOAL ===================================== */

  function shuffle_(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function huruf_(i) { return String.fromCharCode(65 + i); }

  function bukaBarisBaru_(s) {
    return String(s == null ? '' : s)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\n');
  }

  var JUDUL_MAX_ = 300;
  var LABEL_WACANA_BAWAAN = 'Bacalah teks berikut untuk menjawab soal di bawah ini.';

  function pecahTeks_(teks, ukuran) {
    var s = String(teks || '').replace(/\r\n/g, '\n');
    var out = [], i = 0;
    ukuran = Math.max(20, ukuran || JUDUL_MAX_);
    while (i < s.length) {
      if (s.length - i <= ukuran) {
        var sisa = s.substring(i).trim();
        if (sisa) out.push(sisa);
        break;
      }
      var slice = s.substring(i, i + ukuran);
      var min = Math.floor(ukuran * 0.45);
      var br = -1;
      function ambil_(sep) {
        var p = slice.lastIndexOf(sep);
        if (p >= min && p + sep.length > br) br = p + sep.length;
      }
      ambil_('\n\n');
      if (br < 0) ambil_('. ');
      if (br < 0) ambil_('? ');
      if (br < 0) ambil_('! ');
      if (br < 0) ambil_('.\n');
      if (br < 0) ambil_('?\n');
      if (br < 0) ambil_('!\n');
      if (br < 0) ambil_('\n');
      if (br < 0) ambil_(' ');
      if (br < 0) br = ukuran;
      out.push(s.substring(i, i + br).trim());
      i += Math.max(br, 1);
      while (s.charAt(i) === '\n' || s.charAt(i) === ' ') i++;
    }
    return out.filter(function (x) { return x.length; });
  }

  function setHelp_(item, teks) {
    try {
      item.setHelpText(teks);
      return true;
    } catch (eH) {
      return false;
    }
  }

  function _samaStimulus_(a, b) {
    return String(a || '').replace(/\s+/g, ' ').trim() ===
      String(b || '').replace(/\s+/g, ' ').trim();
  }

  function pisahWacanaStem_(text, stimulus) {
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
   * Menulis wacana sebagai judul + deskripsi (SectionHeaderItem).
   * Deskripsi dicoba utuh dulu — jangan dipecah di 300 karakter
   * (batas itu untuk judul, bukan deskripsi).
   */
  function _tulisHeaderWacana_(form, teks, label, dilewati) {
    try {
      var full = String(teks || '').replace(/\r\n/g, '\n').trim();
      if (!full) return true;
      var judul = String(label || LABEL_WACANA_BAWAAN).substring(0, JUDUL_MAX_);
      var h = form.addSectionHeaderItem();
      try { h.setTitle(judul); } catch (eT) {}

      if (setHelp_(h, full)) return true;

      var sizes = [8000, 4000, 2000, 1000, 500, JUDUL_MAX_];
      var chunks = null;
      var si;
      for (si = 0; si < sizes.length; si++) {
        var coba = pecahTeks_(full, sizes[si]);
        if (coba.length && setHelp_(h, coba[0])) {
          chunks = coba;
          break;
        }
      }
      if (!chunks) {
        if (dilewati) dilewati.push('header wacana (teks disisipkan ke judul soal)');
        return false;
      }
      var i;
      for (i = 1; i < chunks.length; i++) {
        var h2 = form.addSectionHeaderItem();
        try { h2.setTitle(' '); } catch (eH2) {}
        if (!setHelp_(h2, chunks[i])) {
          try { h2.setTitle(chunks[i].substring(0, JUDUL_MAX_)); } catch (eT2) {}
        }
      }
      return true;
    } catch (e) {
      if (dilewati) dilewati.push('header wacana (teks disisipkan ke judul soal)');
      return false;
    }
  }

  /**
   * Menormalkan satu soal dari payload client.
   * Wacana (stimulus) DIPERTAHANKAN terpisah dari kalimat tanya supaya
   * addItems_ bisa menulisnya sebagai SectionHeaderItem.
   */
  function normQuestion_(q, i) {
    q = q || {};
    var type = String(q.type || q.tipe || 'pg').toLowerCase();
    if (!LABEL_TIPE[type]) type = 'pg';

    var options = (q.options || q.opsi || []).map(function (o) {
      return String(o == null ? '' : o).trim();
    }).filter(function (o) { return o.length; });

    var correct = (q.correctIdx || q.benar || q.correct || []).map(function (c) {
      return typeof c === 'number' ? Math.round(c) : parseInt(String(c).trim(), 10);
    }).filter(function (c) { return !isNaN(c) && c >= 0 && c < options.length; });

    if (!correct.length && options.length) correct = [0];

    var points = Number(q.points || q.poin || 1);
    if (!isFinite(points) || points < 0) points = 1;

    var rawBenar = q.correctIdx || q.benar || q.correct || q.answerText || [];
    if (!Array.isArray(rawBenar)) rawBenar = [rawBenar];
    var answerText = (type === 'isian' || type === 'essay')
      ? String(rawBenar[0] == null ? '' : rawBenar[0]).trim()
      : '';

    var stimulus = bukaBarisBaru_(q.stimulus || q.wacana || q.bacaan || '').trim();
    var text = bukaBarisBaru_(q.text || q.pertanyaan || q.question || ('Soal ' + (i + 1))).trim();
    var pecah = pisahWacanaStem_(text, stimulus);
    if (pecah.wacana) {
      stimulus = pecah.wacana;
      if (pecah.stem) text = pecah.stem;
    }

    return {
      n: i + 1,
      type: type,
      text: text,
      options: options,
      correct: correct,
      answerText: answerText,
      points: Math.round(points * 100) / 100,
      level: String(q.level || '').trim(),
      materi: String(q.materi || '').trim(),
      indikator: String(q.indikator || '').trim(),
      explanation: String(q.explanation || q.pembahasan || '').trim(),
      helpText: String(q.helpText || '').trim(),
      stimulus: stimulus,
      pakaiStimulus: (q.pakaiStimulus === true || q.pakai_stimulus === true || !!stimulus)
    };
  }

  /**
   * Isian biodata di Bagian 1: Nama, Kelas, No. Absen.
   * Bukan soal kuis (poin 0) tetapi wajib diisi. Soal di Bagian 2.
   */
  function addBiodata_(form, opts, dilewati) {
    try {
      var h = form.addSectionHeaderItem();
      h.setTitle('Biodata siswa');
      try { h.setHelpText('Isi data diri sebelum mengerjakan soal.'); } catch (e0) {}
    } catch (eH) {
      if (dilewati) dilewati.push('header biodata');
    }

    var fields = [
      { title: 'Nama', help: 'Nama lengkap' },
      { title: 'Kelas', help: 'Contoh: VIII A' },
      { title: 'No. Absen', help: 'Nomor urut absen' }
    ];
    fields.forEach(function (f) {
      try {
        var item = form.addTextItem();
        item.setTitle(f.title);
        try { item.setHelpText(f.help); } catch (e1) {}
        try { item.setRequired(true); } catch (e2) {}
        if (opts && opts.isQuiz && item.setPoints) {
          try { item.setPoints(0); } catch (e3) {}
        }
      } catch (eF) {
        if (dilewati) dilewati.push('isian ' + f.title);
      }
    });
  }

  /**
   * Menulis opsi + kunci kuis. setChoiceValues hanya teks; kunci butuh
   * createChoice(teks, benar) lalu setChoices.
   */
  function setOpsiKunci_(item, pairs, dilewati, label) {
    var choices = [];
    var i;
    for (i = 0; i < pairs.length; i++) {
      var teks = String(pairs[i].text || '');
      var benar = !!pairs[i].correct;
      try {
        choices.push(item.createChoice(teks, benar));
      } catch (e1) {
        try { choices.push(item.createChoice(teks)); } catch (e2) {}
      }
    }
    if (choices.length) {
      try {
        item.setChoices(choices);
        return true;
      } catch (e3) {
        if (dilewati) dilewati.push('kunci ' + label);
      }
    }
    try {
      item.setChoiceValues(pairs.map(function (p) { return p.text; }));
    } catch (e4) {}
    return false;
  }

  function setUmpan_(item, teksBenar, teksSalah) {
    try {
      if (item && item.setFeedbackForCorrect) {
        item.setFeedbackForCorrect(FormApp.createFeedback().setText(teksBenar).build());
      }
    } catch (eC) {}
    try {
      if (item && item.setFeedbackForIncorrect) {
        item.setFeedbackForIncorrect(FormApp.createFeedback().setText(teksSalah).build());
      }
    } catch (eW) {}
  }

  /* ====================== PENAMBAHAN ITEM KE FORM ====================== */

  /**
   * @param {FormApp.Form} form
   * @param {Array} questions
   * @param {Object} opts
   * @param {Array=} dilewati catatan fallback
   */
  function addItems_(form, questions, opts, dilewati) {
    var meta = [];
    dilewati = dilewati || [];

    /* Wacana = SectionHeaderItem (Judul + Deskripsi di editor Google Form).
       Urutan soal TIDAK diacak agar judul+deskripsi tetap di atas soalnya. */
    var wacanaTerakhir = '';
    var labelWacana = opts.labelWacana || LABEL_WACANA_BAWAAN;

    questions.forEach(function (q) {
      var teksWacana = (q.pakaiStimulus && q.stimulus) ? q.stimulus : '';

      if (teksWacana && !_samaStimulus_(teksWacana, wacanaTerakhir)) {
        if (_tulisHeaderWacana_(form, teksWacana, labelWacana, dilewati)) {
          wacanaTerakhir = teksWacana;
          teksWacana = '';
        }
      }

      var item = null, jawabanBenar = '';

      if (q.type === 'pg' || q.type === 'pg_kompleks' || q.type === 'dropdown') {
        var pairs = q.options.map(function (text, i) {
          return { text: text, correct: q.correct.indexOf(i) !== -1 };
        });
        if (opts.acakOpsi) pairs = shuffle_(pairs);

        /* PG/dropdown: tepat satu kunci. PG kompleks: boleh banyak. */
        if (q.type !== 'pg_kompleks') {
          var adaKunci = false;
          pairs = pairs.map(function (p) {
            if (p.correct && !adaKunci) { adaKunci = true; return p; }
            return { text: p.text, correct: false };
          });
          if (!adaKunci && pairs.length) pairs[0].correct = true;
        }

        var correctTexts = pairs.filter(function (p) { return p.correct; }).map(function (p) { return p.text; });
        jawabanBenar = correctTexts.join(' | ');

        if (q.type === 'pg') {
          item = form.addMultipleChoiceItem();
        } else if (q.type === 'pg_kompleks') {
          item = form.addCheckboxItem();
          try { item.setHelpText('Pilih ' + correctTexts.length + ' jawaban yang benar.'); } catch (eH1) {}
        } else {
          item = form.addListItem();
        }
        if (opts.isQuiz && item.setPoints) {
          try { item.setPoints(q.points); } catch (eP0) {}
        }
        setOpsiKunci_(item, pairs, dilewati, 'soal ' + q.n);
        setUmpan_(item, feedbackText_(q, correctTexts.join(', ')),
          feedbackWrongText_(q, correctTexts.join(', ')));
      } else if (q.type === 'isian') {
        item = form.addTextItem();
        var kunci = String(q.answerText || (q.options[q.correct[0]] || q.options[0] || '') || '').trim();
        jawabanBenar = kunci;
        if (opts.isQuiz && item.setPoints) {
          try { item.setPoints(q.points); } catch (eP1) {}
        }
        if (kunci && opts.pakaiValidasiIsian !== false) {
          try {
            var v = FormApp.createTextValidation().requireTextEqualTo(kunci);
            item.setValidation(v.setHelpText('Jawaban harus tepat: ' + kunci).build());
          } catch (eV) {}
        }
        setUmpan_(item, feedbackText_(q, kunci), feedbackWrongText_(q, kunci));
      } else {
        item = form.addParagraphTextItem();
        try { if (item && item.setRows) item.setRows(5); } catch (eR) {}
        jawabanBenar = q.explanation || q.options.join(' ') || '(dinilai manual)';
        item.setGeneralFeedback(
          FormApp.createFeedback().setText(
            'Soal uraian dinilai manual oleh guru.' +
            (q.explanation ? '\n\nPoin kunci jawaban:\n' + q.explanation : '')
          ).build());
      }

      if (!item) return;

      var title = opts.nomorOtomatis ? (q.n + '. ' + q.text) : q.text;
      if (teksWacana) {
        /* Header gagal: tempel ke deskripsi soal, bukan ke judul. */
        try { item.setHelpText(teksWacana.substring(0, JUDUL_MAX_)); } catch (eH0) {}
      }
      if (opts.tampilkanLevel && q.level) title += '  [' + q.level + ']';

      try {
        item.setTitle(title);
      } catch (errJudul) {
        try { item.setTitle(String(title).substring(0, JUDUL_MAX_)); }
        catch (e2) { item.setTitle((opts.nomorOtomatis ? (q.n + '. ') : '') + 'Soal ' + q.n); }
      }
      if (q.helpText && item.setHelpText && !teksWacana) {
        try { item.setHelpText(q.helpText); } catch (eH) {}
      }
      if (opts.wajibSemua && item.setRequired) item.setRequired(true);

      if (opts.isQuiz && item.setPoints) {
        try { item.setPoints(q.points); } catch (e) {}
      }

      meta.push({ type: q.type, item: item, jawaban: jawabanBenar, q: q });
    });
    return meta;
  }

  function feedbackText_(q, kunci) {
    var t = '✅ Jawaban benar: ' + (kunci || '-');
    if (q.explanation) t += '\n\n' + q.explanation;
    if (q.level) t += '\n\n(Level: ' + q.level + ' · Poin: ' + q.points + ')';
    return t;
  }

  function feedbackWrongText_(q, kunci) {
    var t = '❌ Jawaban benar: ' + (kunci || '-');
    if (q.explanation) t += '\n\n' + q.explanation;
    return t;
  }

  /* ====================== KUNCI JAWABAN (SPREADSHEET) =================== */

  function createKeySpreadsheet_(folder, title, questions, opts) {
    var ss = SpreadsheetApp.create('KUNCI - ' + title);
    var sh = ss.getSheets()[0];
    sh.setName('Kunci Jawaban');

    var header = ['No', 'Tipe', 'Materi', 'Indikator', 'Wacana', 'Soal', 'Opsi Jawaban', 'Kunci', 'Poin', 'Level', 'Pembahasan'];
    sh.getRange(1, 1, 1, header.length).setValues([header])
      .setFontWeight('bold').setBackground('#1a73e8').setFontColor('#ffffff');

    var rows = questions.map(function (q) {
      var opsi = q.options.map(function (o, i) { return huruf_(i) + '. ' + o; }).join('\n');
      var kunci = q.correct.map(function (i) { return huruf_(i); }).join(', ');
      if (q.type === 'isian') kunci = q.answerText || q.options[0] || '-';
      if (q.type === 'essay') kunci = (q.answerText ? q.answerText + '\n\n' : '') + '(dinilai manual)';
      return [q.n, LABEL_TIPE[q.type] || q.type, q.materi || '-', q.indikator || '-', q.stimulus || '-', q.text, opsi, kunci, q.points, q.level, q.explanation];
    });
    if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);

    var totalPoin = questions.reduce(function (a, q) { return a + q.points; }, 0);
    var last = rows.length + 3;
    sh.getRange(last, 1).setValue('Total').setFontWeight('bold');
    sh.getRange(last, 9).setValue(totalPoin).setFontWeight('bold');
    sh.getRange(last + 1, 1).setValue('Jumlah soal').setFontWeight('bold');
    sh.getRange(last + 1, 9).setValue(questions.length);
    sh.getRange(last + 2, 1).setValue('Dibuat oleh');
    sh.getRange(last + 2, 9).setValue('Soal AI ➜ Google Form · ' + new Date());

    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 45);
    sh.setColumnWidth(2, 140);
    sh.setColumnWidth(3, 180);
    sh.setColumnWidth(4, 220);
    sh.setColumnWidth(5, 360);
    sh.setColumnWidth(6, 380);
    sh.setColumnWidth(7, 280);
    sh.setColumnWidth(8, 80);
    sh.setColumnWidth(9, 60);
    sh.setColumnWidth(10, 70);
    sh.setColumnWidth(11, 380);
    sh.getRange(2, 1, Math.max(rows.length, 1), header.length).setWrap(true).setVerticalAlignment('top');

    // Sheet info
    var info = ss.insertSheet('Info Latihan', 1);
    var infoRows = [
      ['Judul', title],
      ['Mata pelajaran', opts.spec.mapel || '-'],
      ['Kelas', opts.spec.kelas || '-'],
      ['Topik / Materi', opts.spec.topik || '-'],
      ['Kurikulum', opts.spec.kurikulum || '-'],
      ['Level kognitif', (opts.spec.level || []).join(', ')],
      ['Tingkat kesulitan', opts.spec.kesulitan || '-'],
      ['Jumlah soal', questions.length],
      ['Total poin', totalPoin],
      ['Model AI', opts.meta.model || '-'],
      ['Dibuat', Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Jakarta', 'dd MMM yyyy HH:mm')],
      ['Link Form (edit)', opts.formEditUrl || '-'],
      ['Link Form (isi)', opts.formPublishUrl || '-']
    ];
    info.getRange(1, 1, infoRows.length, 2).setValues(infoRows);
    info.getRange(1, 1, infoRows.length, 1).setFontWeight('bold').setBackground('#e8f0fe');
    info.setColumnWidth(1, 180);
    info.setColumnWidth(2, 520);

    try {
      var file = DriveApp.getFileById(ss.getId());
      var dest = folder;
      file.moveTo(dest);
    } catch (e) { /* biarkan di root bila gagal */ }

    return { id: ss.getId(), url: ss.getUrl() };
  }

  /* ====================== API UTAMA ===================================== */

  /**
   * payload = {
   *   spec: {...konfigurasi soal...},
   *   questions: [ {type,text,options,correctIdx,points,level,explanation}, ... ],
   *   form: {
   *     title, description, folderId, targetFormId, isQuiz, acakSoal, acakOpsi,
   *     requireLogin, limitOne, collectEmail, showProgressBar, tampilkanLevel,
   *     nomorOtomatis, wajibSemua, buatKunci, meta{model}
   *   }
   * }
   */
  function build(payload) {
    var raw = payload.questions || [];
    var questions = raw.map(normQuestion_).filter(function (q) { return q.text; });
    if (!questions.length) throw new Error('Tidak ada soal valid untuk dibuat.');

    var spec = payload.spec || {};
    var o = payload.form || {};
    var adaWacana = questions.some(function (q) { return !!(q.stimulus && String(q.stimulus).trim()); });
    var opts = {
      isQuiz: o.isQuiz !== false,
      acakSoal: adaWacana ? false : !!o.acakSoal,
      acakOpsi: !!o.acakOpsi,
      requireLogin: !!o.requireLogin,
      limitOne: !!o.limitOne,
      collectEmail: !!o.collectEmail,
      showProgressBar: o.showProgressBar !== false,
      tampilkanLevel: !!o.tampilkanLevel,
      nomorOtomatis: o.nomorOtomatis !== false,
      wajibSemua: o.wajibSemua !== false,
      isianCaseSensitive: !!o.isianCaseSensitive,
      buatKunci: o.buatKunci !== false,
      modeWacana: o.modeWacana || '',
      labelWacana: o.labelWacana || '',
      spec: spec,
      meta: o.meta || {}
    };

    var title = String(o.title || '').trim() ||
      ('Latihan ' + (spec.mapel || '') + (spec.kelas ? ' - Kelas ' + spec.kelas : '') + ': ' + (spec.topik || '')).replace(/ - $/, '').trim();

    // ---------- Form baru atau tempel ke form lama ----------
    var form, isNew = true, folder;
    if (o.targetFormId) {
      var tid = String(o.targetFormId).indexOf('http') === 0 ? extractId_(o.targetFormId) : String(o.targetFormId).trim();
      form = FormApp.openById(tid);
      isNew = false;
      var parents = DriveApp.getFileById(tid).getParents();
      folder = parents.hasNext() ? parents.next() : resolveFolder_('');
    } else {
      folder = resolveFolder_(o.folderId);
      form = FormApp.create(title);
      try { DriveApp.getFileById(form.getId()).moveTo(folder); } catch (e) {}
    }

    form.setTitle(title);
    var desc = String(o.description || spec.deskripsi || '').trim();
    if (!desc) {
      desc = [
        (spec.mapel ? 'Mata Pelajaran: ' + spec.mapel : ''),
        (spec.kelas ? 'Kelas: ' + spec.kelas : ''),
        (spec.topik ? 'Materi: ' + spec.topik : ''),
        'Jumlah soal: ' + questions.length + ' · Total poin: ' +
          questions.reduce(function (a, q) { return a + q.points; }, 0),
        '',
        'Petunjuk: kerjakan dengan teliti. Soal dibuat dengan bantuan AI — sudah ditinjau guru.',
        'Dibuat: ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Jakarta', 'dd MMM yyyy HH:mm')
      ].filter(Boolean).join('\n');
    }
    form.setDescription(desc);

    // ---------- Pengaturan dasar ----------
    /* Beberapa metode FormApp tidak ada di semua runtime — jangan sampai
       satu pemanggilan membatalkan seluruh pembuatan form. */
    function cobaSet_(nama, nilai) {
      try {
        if (form && typeof form[nama] === 'function') form[nama](nilai);
      } catch (eSet) {}
    }
    if (opts.isQuiz) {
      try { form.setIsQuiz(true); } catch (eQuiz) { cobaSet_('setIsQuiz', true); }
      cobaSet_('setShowLinkToRespondAgain', false);
    }
    /* FormApp tidak punya setShuffleQuestionOrder. Default form = tidak acak
       (cocok untuk wacana sebagai judul+deskripsi). Acak opsi tetap di addItems_. */
    cobaSet_('setShuffleQuestionOrder', !!opts.acakSoal);
    cobaSet_('setRequireLogin', opts.requireLogin);
    cobaSet_('setAllowResponseEdits', false);
    cobaSet_('setProgressBar', opts.showProgressBar);
    cobaSet_('setShowProgressIndicator', opts.showProgressBar);
    cobaSet_('setCollectEmail', opts.collectEmail);
    if (opts.limitOne) cobaSet_('setLimitOneResponsePerUser', true);

    // ---------- Bagian 1: biodata · Bagian 2: soal ----------
    var dilewati = [];
    if (o.biodata !== false) {
      addBiodata_(form, opts, dilewati);
      try {
        var pb = form.addPageBreakItem();
        pb.setTitle('Soal');
        try { pb.setHelpText('Kerjakan soal berikut.'); } catch (ePbH) {}
      } catch (ePb) {
        dilewati.push('bagian soal (page break)');
      }
    } else if (o.pakaiSection) {
      form.addPageBreakItem()
        .setTitle(title)
        .setHelpText(desc.substring(0, 300));
    }

    // ---------- Tambahkan soal ----------
    addItems_(form, questions, opts, dilewati);

    try {
      if (typeof form.saveAndClose === 'function') form.saveAndClose();
    } catch (eSave) {}

    // ---------- Kunci jawaban ----------
    var key = null;
    if (opts.buatKunci) {
      key = createKeySpreadsheet_(folder, title, questions, {
        spec: spec,
        meta: opts.meta,
        formEditUrl: form.getEditUrl(),
        formPublishUrl: form.getPublishedUrl()
      });
    }

    var breakdown = {};
    questions.forEach(function (q) { breakdown[q.type] = (breakdown[q.type] || 0) + 1; });

    return {
      ok: true,
      isNew: isNew,
      formId: form.getId(),
      title: title,
      editUrl: form.getEditUrl(),
      publishUrl: form.getPublishedUrl(),
      shortUrl: (function () { try { return form.getPublishedUrl(); } catch (e) { return ''; } })(),
      folderName: folder.getName(),
      folderUrl: folder.getUrl(),
      jumlahSoal: questions.length,
      totalPoin: questions.reduce(function (a, q) { return a + q.points; }, 0),
      breakdown: breakdown,
      kunci: key,
      dilewati: dilewati
    };
  }

  return {
    build: build,
    resolveFolder_: resolveFolder_,
    extractId_: extractId_,
    normQuestion_: normQuestion_,
    LABEL_TIPE: LABEL_TIPE
  };
})();
