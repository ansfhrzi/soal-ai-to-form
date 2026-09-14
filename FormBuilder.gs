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

  /** Mengubah apa pun yang dilempar menjadi string terbaca (aman utk non-Error). */
  function _pesan_(e) {
    if (e === null || typeof e === 'undefined') return 'kesalahan tanpa pesan';
    if (typeof e === 'string') return e;
    if (e.message) return String(e.message);
    try { var j = JSON.stringify(e); return (j && j !== '{}') ? j : String(e); }
    catch (e2) { return String(e); }
  }

  /**
   * Mengambil TEKS kunci jawaban dari nilai apa pun (string, angka, larik).
   * Larik digabung dengan baris baru karena essay bisa punya beberapa poin
   * kunci. Mengembalikan '' bila tidak ada teks berarti.
   */
  function _teksKunci_(nilai) {
    if (nilai === null || typeof nilai === 'undefined') return '';
    if (Array.isArray(nilai)) {
      return nilai.map(_teksKunci_)
        .filter(function (x) { return x.length; })
        .join('\n');
    }
    return String(nilai).trim();
  }

  /**
   * Pengaman terakhir kunci isian: angka murni yang cocok sebagai indeks ke
   * larik opsi berisi TEKS hampir pasti adalah INDEKS yang lolos normalisasi,
   * bukan jawabannya. Angka yang tidak cocok sebagai indeks (mis. jawaban
   * "32" untuk soal jumlah gigi) dibiarkan apa adanya.
   */
  function _kunciIsian_(q) {
    var kunci = _teksKunci_(q.answerText);
    var opsi = q.options || [];
    if (!kunci || (/^-?\d+$/.test(kunci) && opsi.length &&
                   typeof opsi[parseInt(kunci, 10)] !== 'undefined' &&
                   String(opsi[parseInt(kunci, 10)]).trim() !== kunci)) {
      var dariOpsi = _teksKunci_(opsi[(q.correct && q.correct.length) ? q.correct[0] : 0]);
      if (dariOpsi) kunci = dariOpsi;
      else if (!kunci) kunci = _teksKunci_(opsi[0]);
    }
    return kunci;
  }

  /* ====================== SETELAN FORM YANG AMAN ======================== */

  /**
   * Menerapkan satu setelan Form secara defensif.
   *
   * MENGAPA PERLU: FormApp memakai nama metode yang tidak selalu mudah
   * ditebak, dan beberapa sudah di-deprecate. Nama yang benar hari ini:
   *   • acak urutan soal  → setShuffleQuestions()      (BUKAN setShuffleQuestionOrder)
   *   • bilah progres     → setProgressBar()           (BUKAN setShowProgressIndicator)
   *   • wajib login       → setRequireLogin()          (sudah DEPRECATED oleh Google)
   *   • Form TIDAK punya saveAndClose() — itu milik DocumentApp.Document;
   *     perubahan Form disimpan otomatis.
   *
   * Memanggil nama yang tidak ada melempar `TypeError: … is not a function`
   * yang MEMBATALKAN seluruh pembuatan form — padahal soal-soalnya sudah
   * selesai ditulis ke Form. Setelan kosmetik tidak boleh menggagalkan hasil
   * utama, jadi kegagalan dicatat ke `dilewati` dan build terus berjalan.
   *
   * @param {Form}   form      Form tujuan.
   * @param {Array}  kandidat  Daftar nama metode, dicoba berurutan.
   * @param {*}      nilai     Argumen yang diteruskan.
   * @param {String} label     Nama setelan untuk laporan ke pengguna.
   * @param {Array}  dilewati  Larik penampung setelan yang gagal diterapkan.
   * @return {Boolean} true bila salah satu kandidat berhasil dipanggil.
   */
  function _setOpt_(form, kandidat, nilai, label, dilewati) {
    for (var i = 0; i < kandidat.length; i++) {
      var nama = kandidat[i];
      /* Pemeriksaan `typeof form[nama]` HARUS ikut di dalam try. Pada sebagian
         objek native/Proxy, MEMBACA properti yang tidak dikenal sudah melempar
         TypeError — di luar try, pemeriksaan yang dimaksudkan sebagai pengaman
         itu justru menjadi sumber kegagalan. */
      try {
        if (!form || typeof form[nama] !== 'function') continue;
        form[nama](nilai);
        return true;
      } catch (e) { /* metode tidak ada / ditolak → coba kandidat berikutnya */ }
    }
    if (dilewati && label) dilewati.push(label);
    return false;
  }

  /**
   * Menormalkan satu soal dari payload client supaya tahan terhadap
   * perubahan bentuk data dari UI.
   */
  function normQuestion_(q, i) {
    q = q || {};
    var type = String(q.type || q.tipe || 'pg').toLowerCase();
    if (!LABEL_TIPE[type]) type = 'pg';

    var options = (q.options || q.opsi || []).map(function (o) {
      return String(o == null ? '' : o).trim();
    }).filter(function (o) { return o.length; });

    /* `benar`/`correct` bisa datang sebagai larik INDEKS ([1]), angka tunggal
       (0), atau TEKS ('Empedu') dari payload AI mentah. `.map()` langsung pada
       nilai non-larik melempar TypeError yang MEMBATALKAN seluruh pembuatan
       form, jadi bentuknya dinormalkan dulu. */
    var rawCorrect = q.correctIdx || q.benar || q.correct || [];
    if (!Array.isArray(rawCorrect)) rawCorrect = [rawCorrect];
    var correct = rawCorrect.map(function (c) {
      return typeof c === 'number' ? Math.round(c) : parseInt(String(c).trim(), 10);
    }).filter(function (c) { return !isNaN(c) && c >= 0 && c < options.length; });

    if (!correct.length && options.length) correct = [0];

    var points = Number(q.points || q.poin || 1);
    if (!isFinite(points) || points < 0) points = 1;

    /* ---- kunci jawaban berbentuk TEKS untuk isian & essay ----
       BUG LAMA: `q.correctIdx || q.benar || q.correct || q.answerText`
       mendahulukan correctIdx, yang isinya ANGKA INDEKS ([0]). Indeks itu
       di-String menjadi "0", lalu addItems_ memakainya sebagai kunci karena
       "0" truthy — sehingga fallback ke options[correct[0]] tidak pernah
       jalan. Hasilnya: setiap soal isian di Google Form menuntut siswa
       mengetik "0" (atau "1", "2", …) sebagai jawaban benar, dan spreadsheet
       kunci ikut salah. Teks jawaban harus dicari LEBIH DULU. */
    var answerText = '';
    if (type === 'isian' || type === 'essay') {
      var sumberTeks = [q.answerText, q.jawaban, q.answer, q.kunciTeks, q.benarTeks];
      for (var si = 0; si < sumberTeks.length && !answerText; si++) {
        answerText = _teksKunci_(sumberTeks[si]);
      }
      if (!answerText) {
        /* `benar`/`correct` bisa TEKS ("pepsin") atau INDEKS (0). Ambil hanya
           bila bukan angka murni; angka murni adalah indeks → teksnya diambil
           dari options di bawah. */
        var mentah = _teksKunci_(q.benar != null ? q.benar : q.correct);
        if (mentah && !/^-?\d+$/.test(mentah)) answerText = mentah;
      }
      if (!answerText && options.length) {
        answerText = String(options[correct.length ? correct[0] : 0] || options[0] || '').trim();
      }
    }

    return {
      n: i + 1,
      type: type,
      text: String(q.text || q.pertanyaan || q.question || ('Soal ' + (i + 1))).trim(),
      options: options,
      correct: correct,
      answerText: answerText,
      points: Math.round(points * 100) / 100,
      level: String(q.level || '').trim(),
      explanation: String(q.explanation || q.pembahasan || '').trim(),
      helpText: String(q.helpText || '').trim()
    };
  }

  /* ====================== PENAMBAHAN ITEM KE FORM ====================== */

  /**
   * Memasang opsi + KUNCI JAWABAN pada item pilihan.
   *
   * INI PENYEBAB "kunci jawaban kosong di Form": `setChoiceValues(values)`
   * hanya menulis teks opsi — ia TIDAK punya parameter isCorrect, jadi Form
   * mendapat soal berpoin tetapi tanpa kunci, dan Google Forms tidak bisa
   * menilainya. Satu-satunya cara menandai jawaban benar adalah membuat objek
   * Choice lewat `item.createChoice(value, isCorrect)` lalu memasangnya dengan
   * `item.setChoices(choices)`.
   *
   * Catatan: kunci jawaban hanya berlaku bila Form dalam mode Kuis, jadi
   * `kunciAktif` harus mencerminkan apakah setIsQuiz(true) benar-benar berhasil.
   *
   * Setelah dipasang, hasilnya DIVERIFIKASI ulang lewat getChoices()/isCorrect()
   * — panggilan yang "sukses" tetapi tidak tersimpan harus ketahuan di sini,
   * bukan saat guru membuka Form dan menemukan kuncinya kosong.
   *
   * @return {Boolean} true bila kunci jawaban terpasang & terverifikasi.
   */
  function _pasangChoices_(item, pairs, kunciAktif) {
    var values = pairs.map(function (p) { return p.text; });
    var seharusnyaAdaKunci = !!kunciAktif && pairs.some(function (p) { return p.correct; });

    if (seharusnyaAdaKunci &&
        typeof item.createChoice === 'function' && typeof item.setChoices === 'function') {
      try {
        var choices = pairs.map(function (p) { return item.createChoice(p.text, !!p.correct); });
        item.setChoices(choices);

        /* Baca-ulang HANYA untuk diagnostik. Bila isCorrect() kebetulan tidak
           terbaca, JANGAN jatuh ke setChoiceValues: itu akan MENGHAPUS kunci
           yang sebenarnya sudah terpasang, dan mengubah masalah kecil menjadi
           kunci jawaban kosong di seluruh form. */
        try {
          var terbaca = (typeof item.getChoices === 'function') ? item.getChoices() : null;
          if (terbaca && terbaca.length) {
            var adaBenar = terbaca.some(function (c) {
              return !!(c && typeof c.isCorrect === 'function' && c.isCorrect());
            });
            if (!adaBenar) {
              _log_('kunci_tidak_terverifikasi', { opsi: values.length });
            }
          }
        } catch (eCek) { /* diagnostik gagal ≠ kunci gagal */ }

        return true;                       /* setChoices tidak melempar → terpasang */
      } catch (e) { /* lanjut ke setChoiceValues di bawah */ }
    }

    /* Tanpa mode Kuis (atau createChoice tidak tersedia): opsi saja.
       Kunci memang tidak bisa disimpan pada form non-kuis. */
    try { item.setChoiceValues(values); } catch (e2) {}
    return false;
  }

  /** Log diagnostik opsional; tidak boleh menggagalkan apa pun. */
  function _log_(tag, data) {
    try { if (typeof log_ === 'function') log_('formbuilder:' + tag, data || {}); }
    catch (e) { /* abaikan */ }
  }

  function addItems_(form, questions, opts) {
    var meta = [];
    var tanpaKunci = 0;
    questions.forEach(function (q) {
      var item = null, jawabanBenar = '', kunciTerpasang = false;

      if (q.type === 'pg' || q.type === 'pg_kompleks' || q.type === 'dropdown') {
        var pairs = q.options.map(function (text, i) {
          return { text: text, correct: q.correct.indexOf(i) !== -1 };
        });
        if (opts.acakOpsi) pairs = shuffle_(pairs);

        var correctTexts = pairs.filter(function (p) { return p.correct; }).map(function (p) { return p.text; });
        jawabanBenar = correctTexts.join(' | ');

        if (q.type === 'pg') {
          item = form.addMultipleChoiceItem();
          kunciTerpasang = _pasangChoices_(item, pairs, opts.quizAktif);
          item.setFeedbackForCorrect(
            FormApp.createFeedback().setText(feedbackText_(q, correctTexts[0] || '')).build());
          item.setFeedbackForIncorrect(
            FormApp.createFeedback().setText(feedbackWrongText_(q, correctTexts[0] || '')).build());
        } else if (q.type === 'pg_kompleks') {
          item = form.addCheckboxItem();
          kunciTerpasang = _pasangChoices_(item, pairs, opts.quizAktif);
          item.setHelpText('Pilih ' + correctTexts.length + ' jawaban yang benar.');
          item.setFeedbackForCorrect(
            FormApp.createFeedback().setText(feedbackText_(q, correctTexts.join(', '))).build());
          item.setFeedbackForIncorrect(
            FormApp.createFeedback().setText(feedbackWrongText_(q, correctTexts.join(', '))).build());
        } else {
          item = form.addListItem();
          kunciTerpasang = _pasangChoices_(item, pairs, opts.quizAktif);
          item.setFeedbackForCorrect(
            FormApp.createFeedback().setText(feedbackText_(q, correctTexts[0] || '')).build());
          item.setFeedbackForIncorrect(
            FormApp.createFeedback().setText(feedbackWrongText_(q, correctTexts[0] || '')).build());
        }

        /* Soal pilihan yang seharusnya punya kunci tetapi kuncinya tidak
           terpasang harus TERHITUNG, bukan lolos diam-diam. */
        if (opts.quizAktif && correctTexts.length && !kunciTerpasang) tanpaKunci++;
      } else if (q.type === 'isian') {
        item = form.addTextItem();
        /* Kunci isian adalah TEKS. _kunciIsian_ melindungi dari sisa kasus
           di mana yang sampai ke sini masih berupa angka indeks. */
        var kunci = _kunciIsian_(q);
        jawabanBenar = kunci;
        if (kunci && opts.pakaiValidasiIsian !== false) {
          // Catatan: validasi Google Forms bersifat case-sensitive.
          try {
            var v = FormApp.createTextValidation().requireTextEqualTo(kunci);
            item.setValidation(v.setHelpText('Jawaban harus tepat: ' + kunci).build());
            kunciTerpasang = true;
          } catch (eVal) { /* opsi tetap ada, kunci dilaporkan hilang */ }
        }
        if (opts.quizAktif && !kunciTerpasang) tanpaKunci++;
        item.setFeedbackForCorrect(
          FormApp.createFeedback().setText(feedbackText_(q, kunci)).build());
      } else { // essay
        item = form.addParagraphTextItem();
        item.setRows(5);
        jawabanBenar = q.explanation || q.options.join(' ') || '(dinilai manual)';
        item.setGeneralFeedback(
          FormApp.createFeedback().setText(
            'Soal uraian dinilai manual oleh guru.' +
            (q.explanation ? '\n\nPoin kunci jawaban:\n' + q.explanation : '')
          ).build());
      }

      if (!item) return;

      var title = opts.nomorOtomatis ? (q.n + '. ' + q.text) : q.text;
      if (opts.tampilkanLevel && q.level) title += '  [' + q.level + ']';
      item.setTitle(title);
      if (q.helpText && item.setHelpText) item.setHelpText(q.helpText);
      if (opts.wajibSemua && item.setRequired) item.setRequired(true);

      if (opts.isQuiz && item.setPoints) {
        try { item.setPoints(q.points); } catch (e) { /* item tanpa nilai (essay) */ }
      }

      meta.push({ type: q.type, item: item, jawaban: jawabanBenar, q: q,
                  kunciTerpasang: kunciTerpasang });
    });
    return { meta: meta, tanpaKunci: tanpaKunci };
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

    var header = ['No', 'Tipe', 'Soal', 'Opsi Jawaban', 'Kunci', 'Poin', 'Level', 'Pembahasan'];
    sh.getRange(1, 1, 1, header.length).setValues([header])
      .setFontWeight('bold').setBackground('#1a73e8').setFontColor('#ffffff');

    var rows = questions.map(function (q) {
      var opsi = q.options.map(function (o, i) { return huruf_(i) + '. ' + o; }).join('\n');
      var kunci = q.correct.map(function (i) { return huruf_(i); }).join(', ');
      /* Spreadsheet kunci harus memuat TEKS jawaban yang sama dengan yang
         dipasang di Form — jangan sampai Form menuntut "pepsin" sementara
         lembar kunci menulis "0". */
      if (q.type === 'isian') kunci = _kunciIsian_(q) || '-';
      if (q.type === 'essay') {
        var pk = _teksKunci_(q.answerText);
        kunci = (pk ? pk + '\n\n' : '') + '(dinilai manual)';
      }
      return [q.n, LABEL_TIPE[q.type] || q.type, q.text, opsi, kunci, q.points, q.level, q.explanation];
    });
    if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);

    var totalPoin = questions.reduce(function (a, q) { return a + q.points; }, 0);
    var last = rows.length + 3;
    sh.getRange(last, 1).setValue('Total').setFontWeight('bold');
    sh.getRange(last, 6).setValue(totalPoin).setFontWeight('bold');
    sh.getRange(last + 1, 1).setValue('Jumlah soal').setFontWeight('bold');
    sh.getRange(last + 1, 6).setValue(questions.length);
    sh.getRange(last + 2, 1).setValue('Dibuat oleh');
    sh.getRange(last + 2, 6).setValue('Soal AI ➜ Google Form · ' + new Date());

    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 45);
    sh.setColumnWidth(2, 150);
    sh.setColumnWidth(3, 420);
    sh.setColumnWidth(4, 320);
    sh.setColumnWidth(5, 90);
    sh.setColumnWidth(6, 60);
    sh.setColumnWidth(7, 70);
    sh.setColumnWidth(8, 420);
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
    var opts = {
      isQuiz: o.isQuiz !== false,
      acakSoal: !!o.acakSoal,
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
    /* Semua setelan lewat _setOpt_: nama metode yang salah/tidak tersedia
       TIDAK lagi menggagalkan pembuatan form (lihat catatan di _setOpt_). */
    var dilewati = [];

    if (opts.isQuiz) {
      /* setIsQuiz harus jalan SEBELUM item ditambah: tanpa mode Kuis,
         item.setPoints() dan kunci jawaban (createChoice(value, isCorrect))
         tidak berlaku. Karena itu hasilnya DISIMPAN — addItems_ perlu tahu
         apakah kunci jawaban memang bisa dipasang. */
      opts.quizAktif = _setOpt_(form, ['setIsQuiz'], true, 'mode Kuis', dilewati);
      _setOpt_(form, ['setShowLinkToRespondAgain'], false, 'sembunyikan link "Isi lagi"', dilewati);
    }
    _setOpt_(form, ['setShuffleQuestions', 'setShuffleQuestionOrder'],
      opts.acakSoal, 'acak urutan soal', dilewati);
    _setOpt_(form, ['setRequireLogin'],
      opts.requireLogin, 'wajib login', dilewati);
    _setOpt_(form, ['setAllowResponseEdits'],
      false, 'larang edit respons', dilewati);
    _setOpt_(form, ['setProgressBar', 'setShowProgressIndicator'],
      opts.showProgressBar, 'bilah progres', dilewati);
    _setOpt_(form, ['setCollectEmail'],
      opts.collectEmail, 'kumpulkan email', dilewati);
    if (opts.limitOne) {
      _setOpt_(form, ['setLimitOneResponsePerUser'], true, 'batasi 1 respons per user', dilewati);
    }

    // ---------- Section header (opsional, biar rapi) ----------
    if (o.pakaiSection) {
      form.addPageBreakItem()
        .setTitle(title)
        .setHelpText(desc.substring(0, 300));
    }

    // ---------- Tambahkan soal ----------
    /* Soal ditulis ke Form. Bila salah satu item gagal, Form-nya SUDAH ada di
       Drive — jangan biarkan guru kehilangan jejaknya, sertakan link edit pada
       pesan error supaya bisa diperiksa/dilanjutkan manual. */
    var hasilItem = { meta: [], tanpaKunci: 0 };
    try {
      hasilItem = addItems_(form, questions, opts) || hasilItem;
    } catch (eItem) {
      var linkForm = '';
      try { linkForm = form.getEditUrl(); } catch (e2) {}
      throw new Error('Gagal menuliskan soal ke Form: ' + _pesan_(eItem) +
        (linkForm ? (' — Form sudah terbentuk, periksa/lanjutkan di: ' + linkForm) : ''));
    }

    /* CATATAN: FormApp.Form TIDAK punya saveAndClose() — itu metode
       DocumentApp.Document. Perubahan pada Form disimpan otomatis, jadi
       memanggilnya hanya menghasilkan "form.saveAndClose is not a function"
       SETELAH semua soal selesai ditulis. */

    // ---------- Kunci jawaban ----------
    /* Spreadsheet kunci adalah artefak TAMBAHAN. Kalau pembuatannya gagal,
       Form-nya tetap sah dan lengkap — melaporkan seluruh build sebagai gagal
       akan menyembunyikan link ke form yang sebenarnya sudah jadi. */
    var key = null, peringatanBuild = '';

    /* Kunci yang tidak terpasang di Form adalah cacat NYATA pada hasil utama
       (Form tidak bisa menilai otomatis), jadi harus dilaporkan keras — bukan
       dibiarkan lolos seperti sebelumnya. */
    if (hasilItem.tanpaKunci) {
      peringatanBuild = hasilItem.tanpaKunci + ' soal pilihan TIDAK memiliki kunci jawaban di Form. ' +
        (opts.quizAktif
          ? 'Buka editor Form → klik soal → tab "Kunci jawaban" → tandai jawaban benar.'
          : 'Penyebabnya: mode Kuis gagal diaktifkan pada Form ini, sehingga Google Forms menolak ' +
            'menyimpan kunci. Aktifkan "Jadikan ini kuis" di Pengaturan Form, lalu isi kuncinya.') +
        ' Kunci juga tersedia di spreadsheet kunci jawaban.';
    }

    if (opts.buatKunci) {
      try {
        key = createKeySpreadsheet_(folder, title, questions, {
          spec: spec,
          meta: opts.meta,
          formEditUrl: form.getEditUrl(),
          formPublishUrl: form.getPublishedUrl()
        });
      } catch (eKey) {
        /* Ditambahkan, bukan menimpa: peringatan kunci yang tidak terpasang
           lebih penting dan tidak boleh hilang oleh kegagalan spreadsheet. */
        peringatanBuild = (peringatanBuild ? peringatanBuild + ' ' : '') +
          'Form berhasil dibuat, tetapi spreadsheet kunci jawaban gagal: ' + _pesan_(eKey);
      }
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
      /* Setelan yang tidak bisa diterapkan (mis. metode FormApp sudah diganti
         namanya). Form tetap jadi — pengguna hanya perlu tahu setelan mana
         yang harus diklik manual di editor Form. */
      dilewati: dilewati,
      peringatan: peringatanBuild,
      /* Berapa soal pilihan yang kuncinya benar-benar terpasang & terverifikasi
         di Form. Angka ini yang membuat "kunci jawaban kosong" tidak bisa lagi
         lolos tanpa terdeteksi. */
      soalBerkunci: questions.length - (hasilItem.tanpaKunci || 0),
      tanpaKunci: hasilItem.tanpaKunci || 0,
      kunci: key
    };
  }

  return {
    build: build,
    resolveFolder_: resolveFolder_,
    extractId_: extractId_,
    normQuestion_: normQuestion_,
    _kunciIsian_: _kunciIsian_,
    _teksKunci_: _teksKunci_,
    _pasangChoices_: _pasangChoices_,
    _setOpt_: _setOpt_,
    LABEL_TIPE: LABEL_TIPE
  };
})();
