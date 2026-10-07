// Haku-sensei's Japanese Flashcards App Logic
// State management, multi-language switching, 3D card flipping, TTS speech, Quiz mode, Mylist, and Admin batch import

(function() {
  // --- State ---
  let vocabList = [];
  let students = [];
  let currentStudent = null; // null represents Guest
  let currentLang = 'en'; // default en, switches automatically per student
  let currentDeckFilter = 'all'; // 'all' (shared) or 'mine' (student specific)
  let currentCategory = 'all';
  let isReverseMode = false; // false: Front is Japanese, true: Front is Native Language
  let isCardFlipped = false;
  let currentIndex = 0;
  let activeDeck = [];
  let isSearchStudyMode = false; // true when studying a specific word clicked from search results
  let mylistSet = new Set(); // store card IDs in mylist
  let knownSet = new Set(); // store cards marked as learned
  let isFuriganaEnabled = localStorage.getItem('haku_furigana_enabled') !== 'false'; // default true
  let isAutoAudioEnabled = localStorage.getItem('haku_auto_audio_enabled') === 'true'; // default false
  let autoAudioTimer = null; // timer for debounce / chaining

  // --- Firebase Cloud Sync Configuration ---
  const firebaseConfig = {
    apiKey: "AIzaSyBNsrBL1xRErsuOHgvI7xNs15cai-auoSE",
    authDomain: "japanese-learning-e8a53.firebaseapp.com",
    projectId: "japanese-learning-e8a53",
    storageBucket: "japanese-learning-e8a53.firebasestorage.app",
    messagingSenderId: "1052063287116",
    appId: "1:1052063287116:web:7ccf89640419c489a3f1e9"
  };

  let fbApp = null;
  let fbAuth = null;
  let fbDb = null;
  let isFirebaseReady = false;

  try {
    if (window.firebase) {
      fbApp = firebase.initializeApp(firebaseConfig);
      fbAuth = firebase.auth();
      fbDb = firebase.firestore();
      isFirebaseReady = true;
      console.log('Firebase Cloud Database initialized successfully! ☁️✨');
    }
  } catch (err) {
    console.warn('Firebase init warning:', err);
  }

  // --- Quiz State ---
  let quizPool = [];
  let quizIndex = 0;
  let quizCurrentQuestion = null;
  let quizScore = 0;

  // --- High-Fidelity TTS Speech Engine ---
  // Converts kanji sentences to pure furigana readings using <ruby><rt>furigana</rt></ruby> tags,
  // ensuring the browser's speech synthesizer never misreads words like 二重価格.
  function cleanJapaneseForSpeech(text) {
    if (!text) return '';
    let s = String(text);
    // 1. Remove <rt> and <rp> ruby tags so the original natural kanji text is retained intact.
    // (Inserting spaces around furigana breaks morphological parsing, causing particles like 'は' to be mispronounced as 'ha' instead of 'wa'!)
    s = s.replace(/<rt[^>]*>[\s\S]*?<\/rt>/gi, '');
    s = s.replace(/<rp[^>]*>[\s\S]*?<\/rp>/gi, '');
    // 2. Replace <br> tags with natural sentence pauses (。)
    s = s.replace(/<br\s*\/?>/gi, '。');
    // 3. Remove all remaining HTML tags without inserting spaces between kanji and particles
    s = s.replace(/<[^>]+>/g, '');
    // 4. Strip speaker labels like A: or B:
    s = s.replace(/^[ABａｂＡＢ][:：]\s*/g, '');
    s = s.replace(/[。、!?！？]\s*[ABａｂＡＢ][:：]\s*/g, '。');
    // 5. Remove parenthetical readings: （しんごう） or (しんごう)
    s = s.replace(/[（\(][\u3040-\u309F\u30A0-\u30FF・ー\s]+[）\)]/g, '');
    // 6. Clean duplicate punctuation and extra spaces
    s = s.replace(/[。]+/g, '。');
    return s.replace(/\s+/g, ' ').trim();
  }

  let isSpeaking = false;
  let speechSequenceTimer = null;

  function stopJapaneseSpeech() {
    if (speechSequenceTimer) {
      clearTimeout(speechSequenceTimer);
      speechSequenceTimer = null;
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    isSpeaking = false;
  }

  // Accepts either a string OR a card object { word, reading, example }
  // When given a card, prefers card.reading (e.g. にじゅうかかく) so kanji is read 100% accurately!
  function speakJapanese(target, onEnd = null) {
    if (!('speechSynthesis' in window)) {
      if (onEnd) onEnd();
      return;
    }
    stopJapaneseSpeech();

    let textToSpeak = '';
    if (target && typeof target === 'object') {
      // If object has reading (hiragana), use reading so TTS never mispronounces kanji!
      // (Clean reading of any slash alternatives e.g. "スマートフォン/スマホ" -> "スマートフォン")
      const r = (target.reading || '').split(/[/／・]/)[0].trim();
      textToSpeak = r || target.word || '';
    } else {
      textToSpeak = String(target || '');
    }

    const cleanText = cleanJapaneseForSpeech(textToSpeak);
    if (!cleanText) {
      if (onEnd) onEnd();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = 'ja-JP';
    utterance.rate = 0.9; // natural conversational pacing for Japanese learning

    // Pick Google Japanese TTS voice first if available, then Kyoko / Otoya / Siri or ja-JP voice
    const voices = window.speechSynthesis.getVoices();
    const jaVoice = voices.find(v => (v.lang === 'ja-JP' || v.lang === 'ja_JP') && v.name.includes('Google')) ||
                    voices.find(v => (v.lang === 'ja-JP' || v.lang === 'ja_JP') && (v.name.includes('Kyoko') || v.name.includes('Otoya') || v.name.includes('Siri') || v.name.includes('Nanami') || v.name.includes('Keita'))) ||
                    voices.find(v => v.lang === 'ja-JP' || v.lang === 'ja_JP');
    if (jaVoice) {
      utterance.voice = jaVoice;
    }

    utterance.onstart = () => {
      isSpeaking = true;
    };
    utterance.onend = () => {
      isSpeaking = false;
      if (onEnd) onEnd();
    };
    utterance.onerror = () => {
      isSpeaking = false;
      if (onEnd) onEnd();
    };

    isSpeaking = true;
    window.speechSynthesis.speak(utterance);
  }

  // 連続再生（単語を発音後、例文を続けて再生）
  function speakJapaneseSequence(firstTarget, secondTarget) {
    if (!firstTarget && !secondTarget) return;
    if (!secondTarget) {
      speakJapanese(firstTarget);
      return;
    }
    if (!firstTarget) {
      speakJapanese(secondTarget);
      return;
    }

    stopJapaneseSpeech();

    speakJapanese(firstTarget, () => {
      // 単語読み上げ後に少し間を空けて例文を発話
      speechSequenceTimer = setTimeout(() => {
        speechSequenceTimer = null;
        // カードが途中で閉じられたり切り替わっていないか確認しつつ発音
        if (!('speechSynthesis' in window)) return;
        let textToSpeak = '';
        if (typeof secondTarget === 'object') {
          const r = (secondTarget.reading || '').split(/[/／・]/)[0].trim();
          textToSpeak = r || secondTarget.word || '';
        } else {
          textToSpeak = String(secondTarget || '');
        }
        const cleanText = cleanJapaneseForSpeech(textToSpeak);
        if (!cleanText) return;

        const utterance = new SpeechSynthesisUtterance(cleanText);
        utterance.lang = 'ja-JP';
        utterance.rate = 0.9;
        const voices = window.speechSynthesis.getVoices();
        const jaVoice = voices.find(v => (v.lang === 'ja-JP' || v.lang === 'ja_JP') && v.name.includes('Google')) ||
                        voices.find(v => (v.lang === 'ja-JP' || v.lang === 'ja_JP') && (v.name.includes('Kyoko') || v.name.includes('Otoya') || v.name.includes('Siri') || v.name.includes('Nanami') || v.name.includes('Keita'))) ||
                        voices.find(v => v.lang === 'ja-JP' || v.lang === 'ja_JP');
        if (jaVoice) utterance.voice = jaVoice;

        utterance.onstart = () => {
          isSpeaking = true;
        };
        utterance.onend = () => {
          isSpeaking = false;
        };
        utterance.onerror = () => {
          isSpeaking = false;
        };

        isSpeaking = true;
        window.speechSynthesis.speak(utterance);
      }, 350);
    });
  }

  // 音声ボタンクリック時に再生中なら即座に停止（トグル動作）するヘルパー
  function toggleJapaneseSpeech(target) {
    if (isSpeaking || ('speechSynthesis' in window && window.speechSynthesis.speaking)) {
      stopJapaneseSpeech();
      return;
    }
    speakJapanese(target);
  }

  // --- Bilingual Translation Formatters (必ず母国語 & 英語) ---
  function getBilingualMeaning(meaningObj, lang) {
    if (!meaningObj) return '—';
    const targetLang = lang || currentLang;
    const nativeMeaning = (meaningObj[targetLang]) || '';
    const enMeaning = meaningObj.en || '';

    if (targetLang === 'en') {
      return enMeaning || nativeMeaning || Object.values(meaningObj)[0] || '—';
    }
    if (targetLang === 'ja') {
      return nativeMeaning || enMeaning || Object.values(meaningObj)[0] || '—';
    }
    // For foreign language learners (zh_TW, ko, fr, zh_HK, zh_CN, etc.)
    if (nativeMeaning && enMeaning && nativeMeaning !== enMeaning) {
      return `${nativeMeaning} (${enMeaning})`;
    }
    return nativeMeaning || enMeaning || Object.values(meaningObj)[0] || '—';
  }

  function getBilingualExampleTrans(exampleObj, lang) {
    if (!exampleObj) return '';
    const targetLang = lang || currentLang;
    const nativeEx = (exampleObj[targetLang]) || '';
    const enEx = exampleObj.en || '';

    if (targetLang === 'en') {
      return enEx || nativeEx || '';
    }
    if (targetLang === 'ja') {
      return nativeEx || enEx || '';
    }
    if (nativeEx && enEx && nativeEx !== enEx) {
      return `${nativeEx} <span class="text-slate-400 font-normal">(${enEx})</span>`;
    }
    return nativeEx || enEx || '';
  }

  // --- Toast Notification ---
  function showToast(msg) {
    const toast = document.getElementById('toastNotification');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.remove('opacity-0', 'pointer-events-none');
    toast.classList.add('opacity-100');
    setTimeout(() => {
      toast.classList.remove('opacity-100');
      toast.classList.add('opacity-0', 'pointer-events-none');
    }, 2000);
  }

  // --- Kana / Romaji Normalizer for Search ---
  function toHiragana(str) {
    if (!str) return '';
    // Convert Full-width Romaji/Alphabet to Half-width
    let s = str.replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).toLowerCase();
    // Convert Katakana to Hiragana (30A1-30F6 -> 3041-3096)
    s = s.replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
    return s;
  }

  // --- UI Localization (日本語モード ⇄ 英語モード) ---
  // When 'ja' is selected, UI chrome adapts to Japanese. For all other languages, English is preserved.
  function applyUiLanguage(lang) {
    const isJa = (lang === 'ja');

    // 1. Top Header & Search
    const topSearch = document.getElementById('globalTopSearchInput');
    if (topSearch) {
      topSearch.placeholder = isJa 
        ? '単語を検索（漢字・ひらがな・ローマ字・英語・意味）...' 
        : 'Search words (Kanji, Hiragana, Romaji, English, Meaning)...';
    }

    // 2. Navigation Tabs
    const navStudyLabel = document.getElementById('navStudyLabel');
    if (navStudyLabel) navStudyLabel.textContent = isJa ? 'フラッシュカード' : 'Flashcards';
    const navQuizLabel = document.getElementById('navQuizLabel');
    if (navQuizLabel) navQuizLabel.textContent = isJa ? 'テスト' : 'Quiz / Test';
    const navMylistLabel = document.getElementById('navMylistLabel');
    if (navMylistLabel) navMylistLabel.textContent = isJa ? 'マイリスト' : 'My List';

    // 3. Left Sidebar Curriculum Header
    const sideCurricTitle = document.getElementById('sidebarCurriculumTitle');
    if (sideCurricTitle) sideCurricTitle.textContent = isJa ? 'カリキュラム一覧' : 'Curriculum';
    const sideCurricSub = document.getElementById('sidebarCurriculumSub');
    if (sideCurricSub) sideCurricSub.textContent = isJa ? '全4ステージ / 44単元' : '4 Stages / 44 Units';
    const btnShuffleSideLabel = document.getElementById('btnShuffleAllSidebarLabel');
    if (btnShuffleSideLabel) btnShuffleSideLabel.textContent = isJa ? '全シャッフル' : 'Shuffle All';

    // 4. Deck Controls & Reverse Button
    const filterAll = document.getElementById('filterAllDeck');
    if (filterAll) filterAll.textContent = isJa ? '全員共有' : 'Shared Deck';
    const filterMy = document.getElementById('filterMyDeck');
    if (filterMy) filterMy.textContent = isJa ? '生徒専用' : 'My Deck';

    const reverseLabel = document.getElementById('reverseModeLabel');
    if (reverseLabel) {
      if (isJa) {
        reverseLabel.textContent = isReverseMode ? '表面: 母国語' : '表面: 日本語';
      } else {
        reverseLabel.textContent = isReverseMode ? 'Front: Native' : 'Front: Japanese';
      }
    }

    // 5. Folder & Unit Panels
    const folderOverTitle = document.getElementById('folderOverviewTitle');
    if (folderOverTitle) folderOverTitle.textContent = isJa ? 'フォルダを選択' : 'Select Folder';
    const btnShuffleAllLabel = document.getElementById('btnShuffleAllLabel');
    if (btnShuffleAllLabel) btnShuffleAllLabel.textContent = isJa ? '全単元シャッフル' : 'Shuffle All Units';

    const btnBackToFoldersLabel = document.getElementById('btnBackToFoldersLabel');
    if (btnBackToFoldersLabel) btnBackToFoldersLabel.textContent = isJa ? 'フォルダ一覧に戻る' : 'Back to Folders';
    const unitSelectHint = document.getElementById('unitSelectHint');
    if (unitSelectHint) unitSelectHint.textContent = isJa ? '学習する単元を選択してください' : 'Select a unit to study';
    const btnStudyFolderLabel = document.getElementById('btnStudyEntireFolderLabel');
    if (btnStudyFolderLabel) btnStudyFolderLabel.textContent = isJa ? '全学習' : 'Study All';
    const btnTestFolderLabel = document.getElementById('btnTestEntireFolderLabel');
    if (btnTestFolderLabel) btnTestFolderLabel.textContent = isJa ? 'テスト' : 'Test';

    // 6. Active Study Header Buttons
    const btnTestCurLabel = document.getElementById('btnTestCurrentLabel');
    if (btnTestCurLabel) btnTestCurLabel.textContent = isJa ? 'テスト' : 'Test';
    const btnShuffleCurLabel = document.getElementById('btnShuffleCurrentLabel');
    if (btnShuffleCurLabel) btnShuffleCurLabel.textContent = isJa ? 'シャッフル' : 'Shuffle';

    // 7. Flashcard Face Prompts
    const frontSubtext = document.getElementById('frontSubtext');
    if (frontSubtext) frontSubtext.textContent = isJa ? 'タップして答えを表示' : 'Tap to show answer';
    const frontFlipPrompt = document.getElementById('frontFlipPrompt');
    if (frontFlipPrompt) frontFlipPrompt.textContent = isJa ? 'タップで裏面' : 'Tap to flip';
    const backMeaningLabel = document.getElementById('backMeaningLabel');
    if (backMeaningLabel) backMeaningLabel.textContent = isJa ? '意味・翻訳' : 'Meaning / Translation';
    const backExampleLabel = document.getElementById('backExampleLabel');
    if (backExampleLabel) backExampleLabel.textContent = isJa ? '例文・会話' : 'Example';
    const exampleWordChipsLabel = document.getElementById('exampleWordChipsLabel');
    if (exampleWordChipsLabel) exampleWordChipsLabel.textContent = isJa ? '単語辞書:' : 'Dictionary:';
    const backRelatedLabel = document.getElementById('backRelatedLabel');
    if (backRelatedLabel) backRelatedLabel.textContent = isJa ? '関連語・活用形' : 'Related / Conjugations';
    const backFlipPrompt = document.getElementById('backFlipPrompt');
    if (backFlipPrompt) backFlipPrompt.textContent = isJa ? 'タップして表面に戻る' : 'Tap to flip back';

    // 8. Flashcard Bottom Navigation
    const btnPrevLabel = document.getElementById('btnPrevLabel');
    if (btnPrevLabel) btnPrevLabel.textContent = isJa ? '前へ' : 'Prev';
    const btnMarkReviewLabel = document.getElementById('btnMarkReviewLabel');
    if (btnMarkReviewLabel) btnMarkReviewLabel.textContent = isJa ? 'もう一度！' : 'Again / Review';
    const btnMarkKnownLabel = document.getElementById('btnMarkKnownLabel');
    if (btnMarkKnownLabel) btnMarkKnownLabel.textContent = isJa ? '覚えた！' : 'Learned!';
    const btnNextLabel = document.getElementById('btnNextLabel');
    if (btnNextLabel) btnNextLabel.textContent = isJa ? '次へ' : 'Next';

    // 9. Quiz View
    const quizBadgeTitle = document.getElementById('quizBadgeTitle');
    if (quizBadgeTitle) quizBadgeTitle.textContent = isJa ? '復習テスト' : 'Review Quiz';
    const quizScopeLabel = document.getElementById('quizScopeLabel');
    if (quizScopeLabel) quizScopeLabel.textContent = isJa ? '出題範囲を選択:' : 'Select Quiz Range:';
    const btnQuizScopeCur = document.getElementById('btnQuizScopeCurrent');
    if (btnQuizScopeCur) btnQuizScopeCur.textContent = isJa ? '現在の単元' : 'Unit / Deck';
    const btnQuizScopeMy = document.getElementById('btnQuizScopeMylist');
    if (btnQuizScopeMy) btnQuizScopeMy.textContent = isJa ? '⭐ マイリスト' : '⭐ My List';
    const btnQuizScopeAl = document.getElementById('btnQuizScopeAll');
    if (btnQuizScopeAl) btnQuizScopeAl.textContent = isJa ? '全シャッフル' : 'Shuffle All';
    const quizQuestionPrompt = document.getElementById('quizQuestionPrompt');
    if (quizQuestionPrompt) quizQuestionPrompt.textContent = isJa ? '一致する日本語の単語を選んでください' : 'Select the matching Japanese word';
    const btnQuizNext = document.getElementById('btnQuizNext');
    if (btnQuizNext) btnQuizNext.textContent = isJa ? '次の問題へ' : 'Next Question';

    // 10. Mylist View
    const mylistHeaderTitle = document.getElementById('mylistHeaderTitle');
    if (mylistHeaderTitle) {
      if (lang === 'ja') mylistHeaderTitle.textContent = 'マイリスト';
      else if (lang === 'zh_TW' || lang === 'zh_HK') mylistHeaderTitle.textContent = '我的清單';
      else if (lang === 'zh_CN') mylistHeaderTitle.textContent = '我的清单';
      else if (lang === 'ko') mylistHeaderTitle.textContent = '마이 리스트';
      else if (lang === 'fr') mylistHeaderTitle.textContent = 'Ma liste';
      else mylistHeaderTitle.textContent = 'My List';
    }
    const btnToggleFoldersLabel = document.getElementById('btnToggleMylistFoldersLabel');
    if (btnToggleFoldersLabel) {
      if (lang === 'ja') btnToggleFoldersLabel.textContent = 'フォルダ';
      else if (lang === 'zh_TW' || lang === 'zh_HK') btnToggleFoldersLabel.textContent = '資料夾';
      else if (lang === 'zh_CN') btnToggleFoldersLabel.textContent = '文件夹';
      else if (lang === 'ko') btnToggleFoldersLabel.textContent = '폴더';
      else if (lang === 'fr') btnToggleFoldersLabel.textContent = 'Dossiers';
      else btnToggleFoldersLabel.textContent = 'Folders';
    }
    const mylistFolderSectionTitle = document.getElementById('mylistFolderSectionTitle');
    if (mylistFolderSectionTitle) {
      if (lang === 'ja') mylistFolderSectionTitle.textContent = '📁 フォルダを選択';
      else if (lang === 'zh_TW' || lang === 'zh_HK') mylistFolderSectionTitle.textContent = '📁 選擇資料夾';
      else if (lang === 'zh_CN') mylistFolderSectionTitle.textContent = '📁 选择文件夹';
      else if (lang === 'ko') mylistFolderSectionTitle.textContent = '📁 폴더 선택';
      else if (lang === 'fr') mylistFolderSectionTitle.textContent = '📁 Choisir un dossier';
      else mylistFolderSectionTitle.textContent = '📁 Select Folder';
    }
    const btnCreateMylistLabel = document.getElementById('btnCreateMylistFolderLabel');
    if (btnCreateMylistLabel) {
      if (lang === 'ja') btnCreateMylistLabel.textContent = '+ 新規フォルダ';
      else if (lang === 'zh_TW' || lang === 'zh_HK') btnCreateMylistLabel.textContent = '+ 新增資料夾';
      else if (lang === 'zh_CN') btnCreateMylistLabel.textContent = '+ 新建文件夹';
      else if (lang === 'ko') btnCreateMylistLabel.textContent = '+ 새 폴더';
      else if (lang === 'fr') btnCreateMylistLabel.textContent = '+ Nouveau dossier';
      else btnCreateMylistLabel.textContent = '+ New Folder';
    }
    const btnStudyMylist = document.getElementById('btnStudyMylist');
    const btnStudyMylistLabel = document.getElementById('btnStudyMylistLabel');
    if (btnStudyMylistLabel) {
      let labelText = '練習カード';
      let titleText = '練習カードで学習する';
      if (lang === 'ja') {
        labelText = '練習カード';
        titleText = '練習カードで学習する';
      } else if (lang === 'zh_TW' || lang === 'zh_HK') {
        labelText = '練習卡片';
        titleText = '使用練習卡片學習';
      } else if (lang === 'zh_CN') {
        labelText = '练习卡片';
        titleText = '使用练习卡片学习';
      } else if (lang === 'ko') {
        labelText = '연습 카드';
        titleText = '연습 카드로 학습하기';
      } else if (lang === 'fr') {
        labelText = 'Cartes de pratique';
        titleText = 'Pratiquer avec les cartes mémoire';
      } else {
        labelText = 'Practice Cards';
        titleText = 'Practice with flashcards';
      }
      btnStudyMylistLabel.textContent = labelText;
      if (btnStudyMylist) btnStudyMylist.setAttribute('title', titleText);
    }
    const btnTestMylistLabel = document.getElementById('btnTestMylistLabel');
    if (btnTestMylistLabel) {
      if (lang === 'ja') btnTestMylistLabel.textContent = 'テスト';
      else if (lang === 'zh_TW' || lang === 'zh_HK') btnTestMylistLabel.textContent = '測驗';
      else if (lang === 'zh_CN') btnTestMylistLabel.textContent = '测验';
      else if (lang === 'ko') btnTestMylistLabel.textContent = '테스트';
      else if (lang === 'fr') btnTestMylistLabel.textContent = 'Test';
      else btnTestMylistLabel.textContent = 'Test';
    }

    // 11. Side Drawer Menu
    const drawerMenuLabel = document.getElementById('drawerMenuLabel');
    if (drawerMenuLabel) drawerMenuLabel.textContent = isJa ? 'メニュー' : 'Navigation Menu';
    const drawerHomeLabel = document.getElementById('drawerHomeLabel');
    if (drawerHomeLabel) drawerHomeLabel.textContent = isJa ? 'ホーム (単語カード)' : 'Home (Flashcards)';
    const drawerMylistLabel = document.getElementById('drawerMylistLabel');
    if (drawerMylistLabel) drawerMylistLabel.textContent = isJa ? 'マイリスト' : 'My List';
    const drawerQuizLabel = document.getElementById('drawerQuizLabel');
    if (drawerQuizLabel) drawerQuizLabel.textContent = isJa ? 'テスト' : 'Quiz / Test';
    const drawerLangLabel = document.getElementById('drawerLangLabel');
    if (drawerLangLabel) drawerLangLabel.textContent = isJa ? '母国語設定' : 'Native Language';
    const drawerStudentLabel = document.getElementById('drawerStudentLabel');
    if (drawerStudentLabel) drawerStudentLabel.textContent = isJa ? '生徒アカウント' : 'Student Account';
    const drawerHelpLabel = document.getElementById('drawerHelpLabel');
    if (drawerHelpLabel) drawerHelpLabel.textContent = isJa ? 'ヘルプ・ガイド' : 'Help & Guide';
    const drawerHelpBtnText = document.getElementById('drawerHelpBtnText');
    if (drawerHelpBtnText) drawerHelpBtnText.textContent = isJa ? '使い方ガイド' : 'Help Guide';

    // Update student badge in top header
    const headerStudentBadge = document.getElementById('headerStudentBadge');
    if (headerStudentBadge) {
      if (currentStudent) {
        headerStudentBadge.textContent = isJa ? `生徒: ${currentStudent.name}` : `Student: ${currentStudent.name}`;
      } else {
        headerStudentBadge.textContent = isJa ? '生徒: ゲスト' : 'Student: Guest';
      }
    }

    // 12. Re-render folder overview & units with updated bilingual titles
    if (typeof renderFolderOverview === 'function') {
      renderFolderOverview();
    }
    if (typeof renderSidebarFolderTree === 'function' && !sidebarSearchQuery) {
      renderSidebarFolderTree();
    }
    // Update active study header if currently studying
    const activeHeader = document.getElementById('activeStudyHeader');
    if (activeHeader && !activeHeader.classList.contains('hidden') && typeof FOLDER_CONFIGS !== 'undefined') {
      const fc = FOLDER_CONFIGS.find(f => f.id === currentFolder);
      if (currentSection !== 'all') {
        const sectionsCatalog = window.SECTIONS_DATA || [];
        const catalogItem = sectionsCatalog.find(s => s.num === currentSection);
        const rawSecTitle = catalogItem ? catalogItem.title : (window.SECTIONS && window.SECTIONS[currentSection]) || `単元${currentSection}`;
        document.getElementById('activeStudySectionName').textContent = getBilingualSectionTitle(currentSection, rawSecTitle, lang);
      } else if (fc) {
        document.getElementById('activeStudySectionName').textContent = `${getBilingualFolderTitle(fc, lang)} (${isJa ? '全単元' : 'All Units'})`;
      }
      if (fc) {
        document.getElementById('activeStudyFolderName').textContent = getBilingualFolderTitle(fc, lang);
      }
    }
  }

  // --- Data Loading & Persistence ---
  // --- Data Loading & Persistence ---
  function initData() {
    // Master data version check to ensure newly added cards & furigana updates are immediately visible
    const CURRENT_DATA_VERSION = 'v46_natural_furigana_all';
    const savedVersion = localStorage.getItem('haku_vocab_version');

    const seedCards = window.INITIAL_VOCAB_DATA || [];
    const classCards = window.CLASS_VOCAB_DATA || [];
    const combinedMasterCards = [...seedCards, ...classCards];
    const masterCardMap = new Map();
    combinedMasterCards.forEach(c => masterCardMap.set(c.id, c));

    if (savedVersion !== CURRENT_DATA_VERSION) {
      // Refresh with latest master data while keeping genuinely custom created cards
      const savedVocab = localStorage.getItem('haku_vocab_data');
      if (savedVocab) {
        try {
          const oldList = JSON.parse(savedVocab);
          // Only preserve cards that are genuinely custom (user added) and not part of master class_word or seed
          const customCards = oldList.filter(c => c.isCustom && !masterCardMap.has(c.id));
          vocabList = [...combinedMasterCards, ...customCards];
        } catch (e) {
          vocabList = combinedMasterCards;
        }
      } else {
        vocabList = combinedMasterCards;
      }
      localStorage.setItem('haku_vocab_data', JSON.stringify(vocabList));

      // Reload latest INITIAL_STUDENTS master list when version updates, while preserving edits & newly added ones
      const seedStudents = window.INITIAL_STUDENTS || [];
      const savedStudents = localStorage.getItem('haku_students');
      if (savedStudents) {
        try {
          const parsed = JSON.parse(savedStudents);
          const savedMap = new Map(parsed.map(s => [s.id, s]));
          // Apply teacher's edited names/passcodes onto seed students, or fallback to seed
          students = seedStudents.map(seed => {
            const saved = savedMap.get(seed.id);
            return saved ? { ...seed, ...saved } : seed;
          });
          // Also include any new students added beyond seed
          const seedIds = new Set(seedStudents.map(s => s.id));
          const customExtra = parsed.filter(s => !seedIds.has(s.id) && !s.id.startsWith('student_'));
          students = [...students, ...customExtra];
        } catch (e) {
          students = seedStudents;
        }
      } else {
        students = seedStudents;
      }
      localStorage.setItem('haku_students', JSON.stringify(students));

      // Initialize per-student exact tab card mappings
      const CLASS_FOLDER_ID = 'folder_class_words';
      const CLASS_FOLDER_NAME = '授業で習った言葉';

      const STUDENT_DOC_RANGES = {
        '0012': [1, 289],      // みどりさん (289語)
        '0011': [290, 498],    // Keyvinさん (209語)
        '0013': [499, 538],    // ななさん (40語)
        '0014': [539, 639],    // Danielさん (101語)
        '0015': [640, 873],    // Stephenさん (234語)
        '0016': [874, 1144],   // ジウンさん (271語)
        '0017': [1145, 1213],  // ハンウさん (69語)
        '0018': [1214, 1232],  // Justinさん (19語)
        '0019': [1233, 1314],  // ミンギさん (82語)
        '0020': [1315, 1397],  // Colinさん (83語)
        '0021': [1398, 1598],  // ともやさん (201語)
        '0022': [1599, 1602]   // 生徒22 (追加語彙)
      };

      const allStudentIds = [...students.map(s => s.id), 'guest'];
      allStudentIds.forEach(stId => {
        const key = `haku_mylist_${stId}`;
        const foldersKey = `haku_mylist_folders_${stId}`;
        const mapKey = `haku_mylist_card_map_${stId}`;

        // Ensure "授業で習った言葉" folder exists
        let stFolders = [];
        try { stFolders = JSON.parse(localStorage.getItem(foldersKey) || '[]'); } catch (e) { stFolders = []; }
        if (!stFolders.find(f => f.id === CLASS_FOLDER_ID)) {
          stFolders.unshift({ id: CLASS_FOLDER_ID, name: CLASS_FOLDER_NAME });
          localStorage.setItem(foldersKey, JSON.stringify(stFolders));
        }

        // Clean previous class_word cards from this student's mylist
        let stSet = [];
        try { stSet = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { stSet = []; }
        let stMap = {};
        try { stMap = JSON.parse(localStorage.getItem(mapKey) || '{}'); } catch (e) { stMap = {}; }

        // Remove old class_word_*
        const filteredSet = stSet.filter(id => !id.startsWith('class_word_'));
        Object.keys(stMap).forEach(id => {
          if (id.startsWith('class_word_')) {
            delete stMap[id];
          }
        });

        // Add ONLY this student's specific words
        const range = STUDENT_DOC_RANGES[stId];
        if (range) {
          const [startNum, endNum] = range;
          for (let num = startNum; num <= endNum; num++) {
            const cId = `class_word_${String(num).padStart(4, '0')}`;
            filteredSet.push(cId);
            stMap[cId] = CLASS_FOLDER_ID;
          }
        } else if (stId === '0023' && window.CLASS_ARUN_IDS) {
          // Special exact list for Arun (523 unique words)
          window.CLASS_ARUN_IDS.forEach(cId => {
            filteredSet.push(cId);
            stMap[cId] = CLASS_FOLDER_ID;
          });
        }

        localStorage.setItem(key, JSON.stringify(Array.from(new Set(filteredSet))));
        localStorage.setItem(mapKey, JSON.stringify(stMap));
      });

      localStorage.setItem('haku_vocab_version', CURRENT_DATA_VERSION);
    } else {
      const savedVocab = localStorage.getItem('haku_vocab_data');
      if (savedVocab) {
        try {
          const oldList = JSON.parse(savedVocab);
          const customCards = oldList.filter(c => c.isCustom && !masterCardMap.has(c.id));
          vocabList = [...combinedMasterCards, ...customCards];
        } catch (e) {
          vocabList = combinedMasterCards;
        }
      } else {
        vocabList = combinedMasterCards;
      }

      const savedStudents = localStorage.getItem('haku_students');
      if (savedStudents) {
        try {
          students = JSON.parse(savedStudents);
        } catch (e) {
          students = window.INITIAL_STUDENTS || [];
        }
      } else {
        students = window.INITIAL_STUDENTS || [];
      }
    }

    // Load active student session if stored
    const savedStudentId = localStorage.getItem('haku_current_student_id');
    if (savedStudentId) {
      const found = students.find(s => s.id === savedStudentId);
      if (found) {
        setStudent(found);
      }
    }

    loadMylistForCurrentStudent();
    applyUiLanguage(currentLang);
    renderFolderOverview();
    initSidebarWordList();
    initLayoutMode();
    updateActiveDeck();
    renderAdminStudentList();
  }

  // --- Left Sidebar Wordbook & Unified Search with Inline Accordion ---
  // --- Left Sidebar Vertical Folders & Curriculum List (PC版: 縦の箇条書き) ---
  let sidebarSearchQuery = '';
  let expandedFolderIds = new Set(['folder_1', 'folder_2', 'folder_3', 'folder_4']); // all open by default so students see everything
  let expandedWordId = null; // Track currently expanded accordion item

  function initSidebarWordList() {
    renderSidebarContent();

    const topSearch = document.getElementById('globalTopSearchInput');
    const clearTopBtn = document.getElementById('btnClearTopSearch');

    if (topSearch) {
      topSearch.addEventListener('input', (e) => {
        sidebarSearchQuery = e.target.value.trim().toLowerCase();
        if (clearTopBtn) {
          clearTopBtn.classList.toggle('hidden', !sidebarSearchQuery);
        }
        renderSidebarContent();
      });

      // Show dropdown on focus if input has value
      topSearch.addEventListener('focus', () => {
        if (sidebarSearchQuery) {
          const dropdown = document.getElementById('searchDropdownContainer');
          if (dropdown) dropdown.classList.remove('hidden');
        }
      });
    }

    if (clearTopBtn) {
      clearTopBtn.addEventListener('click', () => {
        if (topSearch) topSearch.value = '';
        sidebarSearchQuery = '';
        clearTopBtn.classList.add('hidden');
        const dropdown = document.getElementById('searchDropdownContainer');
        if (dropdown) dropdown.classList.add('hidden');
        renderSidebarContent();

        // If the user was viewing a searched word card, return to folder overview
        if (isSearchStudyMode) {
          backToFolderOverview();
        }
      });
    }

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      const topSearchContainer = document.getElementById('globalTopSearchInput')?.parentElement;
      const dropdown = document.getElementById('searchDropdownContainer');
      if (dropdown && topSearchContainer && !topSearchContainer.contains(e.target)) {
        dropdown.classList.add('hidden');
      }
    });

    // Connect sidebar shuffle button
    const btnShuffleSidebar = document.getElementById('btnShuffleAllSidebar');
    if (btnShuffleSidebar) {
      btnShuffleSidebar.addEventListener('click', () => {
        currentFolder = 'all';
        currentSection = 'all';
        const isJa = currentLang === 'ja';
        document.getElementById('activeStudySectionName').textContent = isJa ? '全単元 (全シャッフル)' : 'All Units (Shuffle All)';
        document.getElementById('activeStudyFolderName').textContent = isJa ? 'カリキュラム一覧' : 'Curriculum';
        document.getElementById('folderOverviewPanel').classList.add('hidden');
        document.getElementById('unitListPanel').classList.add('hidden');
        document.getElementById('activeStudyHeader').classList.remove('hidden');

        updateActiveDeck();
        activeDeck.sort(() => Math.random() - 0.5);
        currentIndex = 0;
        renderCurrentCard();
        showToast(isJa ? '全単元をシャッフルしました！🔀' : 'Shuffled all curriculum cards! 🔀');
      });
    }
  }

  // Smart dispatch: show vertical folders by default, or matched search words when searching
  function renderSidebarContent() {
    const rawQuery = (sidebarSearchQuery || '').trim();
    if (rawQuery) {
      renderUnifiedSearchResults(rawQuery);
    } else {
      const dropdown = document.getElementById('searchDropdownContainer');
      if (dropdown) dropdown.classList.add('hidden');
      renderSidebarFolderTree();
    }
  }

  // --- Filtering & Deck Navigation System ---
  let currentFolder = 'all'; // 'folder_1', 'folder_2', 'folder_3', 'folder_4'
  let currentSection = 'all'; // 1 to 43 or 'all'
  let currentNavLevel = 'folders'; // 'folders' (level 1), 'units' (level 2), 'study' (level 3)

  const FOLDER_CONFIGS = [
    {
      id: 'folder_1',
      title: '初級 1-10',
      desc: '挨拶・身の回り・家族・場所・体・数字',
      range: [1, 10],
      badge: 'STAGE 1',
      trans: {
        en: 'Beginner 1-10',
        zh_TW: '初級 1-10',
        zh_CN: '初级 1-10',
        ko: '초급 1-10',
        zh_HK: '初級 1-10',
        fr: 'Débutant 1-10'
      }
    },
    {
      id: 'folder_2',
      title: '初級 11-20',
      desc: '日時・数え方・動詞・食べ物・する動詞',
      range: [11, 20],
      badge: 'STAGE 2',
      trans: {
        en: 'Beginner 11-20',
        zh_TW: '初級 11-20',
        zh_CN: '初级 11-20',
        ko: '초급 11-20',
        zh_HK: '初級 11-20',
        fr: 'Débutant 11-20'
      }
    },
    {
      id: 'folder_3',
      title: '初級 21-30',
      desc: '会話・形容詞・予定・天気・電車・て形',
      range: [21, 30],
      badge: 'STAGE 3',
      trans: {
        en: 'Beginner 21-30',
        zh_TW: '初級 21-30',
        zh_CN: '初级 21-30',
        ko: '초급 21-30',
        zh_HK: '初級 21-30',
        fr: 'Débutant 21-30'
      }
    },
    {
      id: 'folder_4',
      title: '初級 31-43',
      desc: 'て形応用・動詞4/5・病気・ない形・可能形',
      range: [31, 43],
      badge: 'STAGE 4',
      trans: {
        en: 'Beginner 31-43',
        zh_TW: '初級 31-43',
        zh_CN: '初级 31-43',
        ko: '초급 31-43',
        zh_HK: '初級 31-43',
        fr: 'Débutant 31-43'
      }
    }
  ];

  // Multilingual translations for all 44 curriculum unit titles
  const SECTION_TRANSLATIONS = {
    0: { en: 'Classroom Phrases', zh_TW: '課堂常用句', zh_CN: '课堂常用句', ko: '수업 필수 표현', zh_HK: '課堂常用句', fr: 'Phrases de classe' },
    1: { en: 'Simple Phrases', zh_TW: '簡易短句', zh_CN: '简易短句', ko: '간단한 표현', zh_HK: '簡易短句', fr: 'Phrases simples' },
    2: { en: 'Everyday Objects', zh_TW: '隨身物品', zh_CN: '随身物品', ko: '주변 사물', zh_HK: '隨身物品', fr: 'Objets du quotidien' },
    3: { en: 'Pronouns & Family', zh_TW: '代名詞與家族', zh_CN: '代名词与家族', ko: '대명사 및 가족', zh_HK: '代名詞與家族', fr: 'Pronoms et Famille' },
    4: { en: 'Places', zh_TW: '場所', zh_CN: '场所', ko: '장소', zh_HK: '場所', fr: 'Lieux' },
    5: { en: 'Animals', zh_TW: '動物', zh_CN: '动物', ko: '동물', zh_HK: '動物', fr: 'Animaux' },
    6: { en: 'Occupations & Status', zh_TW: '職業與身分', zh_CN: '职业与身分', ko: '직업 및 신분', zh_HK: '職業與身分', fr: 'Métiers et Statut' },
    7: { en: 'Countries & Locations', zh_TW: '國家與地名', zh_CN: '国家与地名', ko: '국가 및 지명', zh_HK: '國家與地名', fr: 'Pays et Lieux' },
    8: { en: 'Body Parts', zh_TW: '身體部位', zh_CN: '身体部位', ko: '신체 부위', zh_HK: '身體部位', fr: 'Parties du corps' },
    9: { en: 'Positions & Directions', zh_TW: '方位與位置', zh_CN: '方位与位置', ko: '위치 및 방향', zh_HK: '方位與位置', fr: 'Positions' },
    10: { en: 'Basic Numbers', zh_TW: '基本數字', zh_CN: '基本数字', ko: '기본 숫자', zh_HK: '基本數字', fr: 'Nombres de base' },
    11: { en: 'Dates (Month / Day)', zh_TW: '日期（月份／日期）', zh_CN: '日期（月份／日期）', ko: '날짜 (월/일)', zh_HK: '日期（月份／日期）', fr: 'Dates (Mois / Jour)' },
    12: { en: 'Time & Time Periods', zh_TW: '時間與時段', zh_CN: '时间与时段', ko: '시간 및 시간대', zh_HK: '時間與時段', fr: 'Heure et Périodes' },
    13: { en: 'Counters (Things / People)', zh_TW: '計數詞（物／人）', zh_CN: '计数词（物／人）', ko: '수사 (사물/사람)', zh_HK: '計數詞（物／人）', fr: 'Compteurs' },
    14: { en: 'Time & Tense Expressions', zh_TW: '時間與時態', zh_CN: '时间与时态', ko: '시간 및 시제 표현', zh_HK: '時間與時態', fr: 'Temps et Expressions temporelles' },
    15: { en: 'Basic Verbs 1', zh_TW: '基本動詞 1', zh_CN: '基本动词 1', ko: '기본 동사 1', zh_HK: '基本動詞 1', fr: 'Verbes de base 1' },
    16: { en: 'Vehicles & Transport', zh_TW: '交通工具', zh_CN: '交通工具', ko: '교통수단', zh_HK: '交通工具', fr: 'Transports' },
    17: { en: 'Time & Frequency', zh_TW: '時間與頻率', zh_CN: '时间与频率', ko: '시간 및 빈도', zh_HK: '時間與頻率', fr: 'Temps et Fréquence' },
    18: { en: 'Food & Drinks', zh_TW: '食物與飲食', zh_CN: '食物与饮食', ko: '음식', zh_HK: '食物與飲食', fr: 'Nourriture' },
    19: { en: 'Basic Verbs 2', zh_TW: '基本動詞 2', zh_CN: '基本动词 2', ko: '기본 동사 2', zh_HK: '基本動詞 2', fr: 'Verbes de base 2' },
    20: { en: 'Suru Verbs (Nouns)', zh_TW: 'Suru動詞（名詞）', zh_CN: 'Suru动词（名词）', ko: 'Suru 동사 (명사)', zh_HK: 'Suru動詞（名詞）', fr: 'Verbes en Suru' },
    21: { en: 'Fillers & Conjunctions', zh_TW: '隨聲附和與連接詞', zh_CN: '随声附和与连接词', ko: '맞장구 및 접속사', zh_HK: '隨聲附和與連接詞', fr: 'Interjections et Conjonctions' },
    22: { en: 'I-Adjectives 1', zh_TW: 'い形容詞 1', zh_CN: 'い形容词 1', ko: 'い형용사 1', zh_HK: 'い形容詞 1', fr: 'Adjectifs en -i 1' },
    23: { en: 'Na-Adjectives', zh_TW: 'な形容詞', zh_CN: 'な形容词', ko: 'な형용사', zh_HK: 'な形容詞', fr: 'Adjectifs en -na' },
    24: { en: 'Colors & Tastes', zh_TW: '顏色與味道', zh_CN: '颜色与味道', ko: '색상 및 맛', zh_HK: '顏色與味道', fr: 'Couleurs et Goûts' },
    25: { en: 'Plans, Movies & Sports', zh_TW: '計畫、電影與運動', zh_CN: '计划、电影与运动', ko: '일정, 영화, 스포츠', zh_HK: '計畫、電影與運動', fr: 'Projets, Films et Sports' },
    26: { en: 'Seasons & Weather', zh_TW: '季節與天氣', zh_CN: '季节与天气', ko: '계절 및 날씨', zh_HK: '季節與天氣', fr: 'Saisons et Météo' },
    27: { en: 'Basic Verbs 3', zh_TW: '基本動詞 3', zh_CN: '基本动词 3', ko: '기본 동사 3', zh_HK: '基本動詞 3', fr: 'Verbes de base 3' },
    28: { en: 'Going Out', zh_TW: '外出', zh_CN: '外出', ko: '외출', zh_HK: '外出', fr: 'Sorties' },
    29: { en: 'Trains & Subways', zh_TW: '電車與鐵路', zh_CN: '电车与铁路', ko: '전철 및 기차', zh_HK: '電車與鐵路', fr: 'Train et Métro' },
    30: { en: 'Basic Verbs 1 (Te-form)', zh_TW: '基本動詞 1（て形）', zh_CN: '基本动词 1（て形）', ko: '기본 동사 1 (て형)', zh_HK: '基本動詞 1（て形）', fr: 'Verbes de base 1 (forme en te)' },
    31: { en: 'Basic Verbs 2 (Te-form)', zh_TW: '基本動詞 2（て形）', zh_CN: '基本动词 2（て形）', ko: '기본 동사 2 (て형)', zh_HK: '基本動詞 2（て形）', fr: 'Verbes de base 2 (forme en te)' },
    32: { en: 'Basic Verbs 3 (Te-form)', zh_TW: '基本動詞 3（て形）', zh_CN: '基本动词 3（て形）', ko: '기본 동사 3 (て형)', zh_HK: '基本動詞 3（て形）', fr: 'Verbes de base 3 (forme en te)' },
    33: { en: 'Basic Verbs 4', zh_TW: '基本動詞 4', zh_CN: '基本动词 4', ko: '기본 동사 4', zh_HK: '基本動詞 4', fr: 'Verbes de base 4' },
    34: { en: 'Basic Verbs 5', zh_TW: '基本動詞 5', zh_CN: '基本动词 5', ko: '기본 동사 5', zh_HK: '基本動詞 5', fr: 'Verbes de base 5' },
    35: { en: 'I-Adjectives 2', zh_TW: 'い形容詞 2', zh_CN: 'い形容词 2', ko: 'い형용사 2', zh_HK: 'い形容詞 2', fr: 'Adjectifs en -i 2' },
    36: { en: 'Illness & Symptoms', zh_TW: '疾病與症狀', zh_CN: '疾病与症状', ko: '질병 및 증상', zh_HK: '疾病與症狀', fr: 'Maladie et Symptômes' },
    37: { en: 'Basic Verbs 1 (Nai-form)', zh_TW: '基本動詞 1（ない形）', zh_CN: '基本动词 1（ない形）', ko: '기본 동사 1 (ない형)', zh_HK: '基本動詞 1（ない形）', fr: 'Verbes de base 1 (forme en nai)' },
    38: { en: 'Basic Verbs 2 (Nai-form)', zh_TW: '基本動詞 2（ない形）', zh_CN: '基本动词 2（ない形）', ko: '기본 동사 2 (ない형)', zh_HK: '基本動詞 2（ない形）', fr: 'Verbes de base 2 (forme en nai)' },
    39: { en: 'Basic Verbs 3 (Nai-form)', zh_TW: '基本動詞 3（ない形）', zh_CN: '基本动词 3（ない形）', ko: '기본 동사 3 (ない형)', zh_HK: '基本動詞 3（ない形）', fr: 'Verbes de base 3 (forme en nai)' },
    40: { en: 'Basic Verbs 4 (Nai-form)', zh_TW: '基本動詞 4（ない形）', zh_CN: '基本动词 4（ない形）', ko: '기본 동사 4 (ない형)', zh_HK: '基本動詞 4（ない形）', fr: 'Verbes de base 4 (forme en nai)' },
    41: { en: 'Basic Verbs 5 (Nai-form)', zh_TW: '基本動詞 5（ない形）', zh_CN: '基本动词 5（ない形）', ko: '기본 동사 5 (ない형)', zh_HK: '基本動詞 5（ない形）', fr: 'Verbes de base 5 (forme en nai)' },
    42: { en: 'Basic Verbs 1 (Potential)', zh_TW: '基本動詞 1（可能形）', zh_CN: '基本动词 1（可能形）', ko: '기본 동사 1 (가능형)', zh_HK: '基本動詞 1（可能形）', fr: 'Verbes de base 1 (forme potentielle)' },
    43: { en: 'Basic Verbs 2 (Potential)', zh_TW: '基本動詞 2（可能形）', zh_CN: '基本动词 2（可能形）', ko: '기본 동사 2 (가능형)', zh_HK: '基本動詞 2（可能形）', fr: 'Verbes de base 2 (forme potentielle)' }
  };

  // Helper to format bilingual title: 日本語 (各言語訳)
  function getBilingualSectionTitle(secNum, rawJapaneseTitle, lang) {
    const jpTitle = rawJapaneseTitle || (SECTION_TRANSLATIONS[secNum] ? SECTION_TRANSLATIONS[secNum].ja : `単元${secNum}`);
    if (lang === 'ja' || !lang) {
      return jpTitle;
    }
    const tMap = SECTION_TRANSLATIONS[secNum];
    if (!tMap) return jpTitle;
    const trans = tMap[lang] || tMap.en;
    if (!trans) return jpTitle;
    return `${jpTitle} (${trans})`;
  }

  function getBilingualFolderTitle(fc, lang) {
    if (!fc) return '';
    if (lang === 'ja' || !lang) return fc.title;
    const trans = fc.trans ? (fc.trans[lang] || fc.trans.en) : null;
    if (!trans || trans === fc.title) return fc.title;
    return `${fc.title} (${trans})`;
  }

  // Render vertical bullet / hierarchical folder tree (PC版 縦の箇条書きスタイル)
  function renderSidebarFolderTree() {
    const container = document.getElementById('sidebarFolderListContainer');
    if (!container) return;
    container.innerHTML = '';

    const sectionsCatalog = window.SECTIONS_DATA || [];
    const sectionsMap = window.SECTIONS || {};

    FOLDER_CONFIGS.forEach(fc => {
      const isExpanded = expandedFolderIds.has(fc.id);
      const folderCards = vocabList.filter(c => c.folder_id === fc.id);
      const bilingualFolderTitle = getBilingualFolderTitle(fc, currentLang);

      // Folder Item Container
      const folderWrapper = document.createElement('div');
      folderWrapper.className = 'border border-softBorder rounded-2xl bg-white shadow-2xs overflow-hidden transition-all';

      // Folder Header
      const headerDiv = document.createElement('div');
      headerDiv.className = 'px-3 py-2.5 bg-slate-50/80 hover:bg-lightBlueBg/40 cursor-pointer flex items-center justify-between transition select-none';
      headerDiv.innerHTML = `
        <div class="flex items-center space-x-2 truncate pr-2">
          <i data-lucide="${isExpanded ? 'folder-open' : 'folder'}" class="w-4 h-4 text-deepNavy shrink-0"></i>
          <div class="truncate">
            <span class="text-xs font-bold text-darkNavyText truncate">${bilingualFolderTitle}</span>
            <span class="text-[10px] text-slate-400 font-medium ml-1">(${folderCards.length}語)</span>
          </div>
        </div>
        <div class="flex items-center space-x-1 shrink-0">
          <button class="btn-folder-play p-1 text-deepNavy hover:bg-white rounded-lg transition" title="Study this entire folder">
            <i data-lucide="play" class="w-3.5 h-3.5 fill-deepNavy text-deepNavy"></i>
          </button>
          <button class="btn-folder-test p-1 text-emerald-600 hover:bg-white rounded-lg transition" title="Quiz this folder">
            <i data-lucide="check-circle-2" class="w-3.5 h-3.5 text-emerald-600"></i>
          </button>
          <i data-lucide="${isExpanded ? 'chevron-up' : 'chevron-down'}" class="w-4 h-4 text-slate-400"></i>
        </div>
      `;

      // Click header toggles folder collapse
      headerDiv.addEventListener('click', (e) => {
        if (e.target.closest('.btn-folder-play')) {
          e.stopPropagation();
          currentFolder = fc.id;
          startStudyingEntireFolder();
          renderSidebarFolderTree();
          return;
        }
        if (e.target.closest('.btn-folder-test')) {
          e.stopPropagation();
          currentFolder = fc.id;
          startQuizWithScope('folder', fc.id, fc.title);
          return;
        }
        if (expandedFolderIds.has(fc.id)) {
          expandedFolderIds.delete(fc.id);
        } else {
          expandedFolderIds.add(fc.id);
        }
        renderSidebarFolderTree();
      });

      folderWrapper.appendChild(headerDiv);

      // Units Bullet List inside Folder
      if (isExpanded) {
        const unitsContainer = document.createElement('div');
        unitsContainer.className = 'py-1 px-1.5 space-y-0.5 border-t border-slate-100 bg-white';

        const [minSec, maxSec] = fc.range;
        // For folder_1, also check for Section 0 (まずは授業で使う単語を覚えよう！)
        const secNumsToRender = [];
        if (fc.id === 'folder_1') {
          secNumsToRender.push(0);
        }
        for (let s = minSec; s <= maxSec; s++) {
          secNumsToRender.push(s);
        }

        secNumsToRender.forEach(secNum => {
          const catalogItem = sectionsCatalog.find(s => s.num === secNum);
          if (!catalogItem && !sectionsMap[secNum] && vocabList.filter(c => c.section_num === secNum).length === 0) {
            return;
          }
          const rawSecTitle = (catalogItem && catalogItem.title) || sectionsMap[secNum] || `${secNum}. 単元${secNum}`;
          const bilingualTitle = getBilingualSectionTitle(secNum, rawSecTitle, currentLang);
          const count = vocabList.filter(c => c.section_num === secNum).length;
          const isCurrentActive = (currentSection == secNum && currentFolder === fc.id);
          const numDisplay = secNum === 0 ? '★' : `${secNum}`;

          const unitItem = document.createElement('div');
          unitItem.className = `group flex items-center justify-between px-2.5 py-1.5 rounded-xl cursor-pointer transition text-xs ${
            isCurrentActive 
              ? 'bg-lightBlueBg/70 text-deepNavy font-bold border border-softBorder shadow-2xs' 
              : 'text-slate-700 hover:bg-slate-50 font-medium'
          }`;

          unitItem.innerHTML = `
            <div class="flex items-center space-x-2 truncate pr-2">
              <span class="w-1.5 h-1.5 rounded-full ${isCurrentActive ? 'bg-deepNavy' : 'bg-slate-300 group-hover:bg-coralPink'}"></span>
              <span class="text-[11px] font-bold text-slate-400 w-4 text-center">${numDisplay}</span>
              <span class="truncate text-[11px]">${bilingualTitle}</span>
            </div>
            <div class="flex items-center space-x-1 shrink-0">
              <span class="text-[9px] px-1.5 py-0.2 rounded-full font-bold ${isCurrentActive ? 'bg-deepNavy text-white' : 'bg-slate-100 text-slate-500'}">${count}語</span>
              <i data-lucide="chevron-right" class="w-3 h-3 text-slate-300 group-hover:text-deepNavy transition"></i>
            </div>
          `;

          unitItem.addEventListener('click', () => {
            currentFolder = fc.id;
            startStudyingSection(secNum, rawSecTitle);
            renderSidebarFolderTree();
          });

          unitsContainer.appendChild(unitItem);
        });

        folderWrapper.appendChild(unitsContainer);
      }

      container.appendChild(folderWrapper);
    });

    lucide.createIcons({ root: container });
  }

  // Render unified search results both into Dropdown (Mobile/PC instant preview) and Sidebar (PC tree)
  // Helper to calculate relevance score for search query
  function calculateSearchRelevance(item, rawQuery, hiraQuery) {
    let score = 0;
    const w = (item.word || '').toLowerCase();
    const r = (item.reading || '').toLowerCase();
    const rHira = toHiragana(r);
    const wHira = toHiragana(w);

    // Exact match on word or reading (highest priority)
    if (w === rawQuery || r === rawQuery || wHira === hiraQuery || rHira === hiraQuery) {
      score += 10000;
    } else if (w.startsWith(rawQuery) || r.startsWith(rawQuery) || wHira.startsWith(hiraQuery) || rHira.startsWith(hiraQuery)) {
      score += 5000;
    } else if (w.includes(rawQuery) || r.includes(rawQuery) || wHira.includes(hiraQuery) || rHira.includes(hiraQuery)) {
      score += 2000;
    }

    // Meaning matches (English, Chinese, etc.)
    const meaningObj = item.meaning || {};
    const meaningsList = Object.values(meaningObj).filter(Boolean);
    const combinedMeanings = meaningsList.join(' ').toLowerCase();

    // Check individual meanings or words
    let exactMeaningMatch = false;
    let wordBoundaryMatch = false;

    // Regex for word boundary in English/alphabetic queries (e.g., "\bcat\b")
    const isAlpha = /^[a-zA-Z0-9\s]+$/.test(rawQuery);
    const boundRegex = isAlpha ? new RegExp(`\\b${rawQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') : null;

    for (const m of meaningsList) {
      const mStr = String(m).toLowerCase();
      // Split by comma or semicolon
      const subMeanings = mStr.split(/[,;\/|]/).map(s => s.trim());
      for (const sm of subMeanings) {
        if (sm === rawQuery) {
          exactMeaningMatch = true;
          break;
        }
      }
      if (boundRegex && boundRegex.test(mStr)) {
        wordBoundaryMatch = true;
      }
    }

    if (exactMeaningMatch) {
      score += 8000;
    } else if (wordBoundaryMatch) {
      score += 4000;
    } else if (combinedMeanings.startsWith(rawQuery)) {
      score += 3000;
    } else if (combinedMeanings.includes(rawQuery)) {
      score += 1500;
    }

    // Example sentence matches
    const exJa = (item.example && item.example.ja ? item.example.ja.replace(/<[^>]+>/g, '') : '').toLowerCase();
    const exJaHira = toHiragana(exJa);
    if (exJa.includes(rawQuery) || exJaHira.includes(hiraQuery)) {
      score += 300;
    }
    const exTrans = Object.values(item.example || {}).join(' ').toLowerCase();
    if (exTrans.includes(rawQuery)) {
      score += 200;
    }

    // Boost curriculum cards slightly over dictionary entries when scores are comparable
    if (!item.isDict) {
      score += 50;
    }

    // Prefer shorter words when matching query (e.g., "cat" -> "猫" over long expressions)
    if (w.length > 0 && score > 0) {
      score += Math.max(0, 30 - w.length);
    }

    return score;
  }

  // Render unified search results both into Dropdown (Mobile/PC instant preview) and Sidebar (PC tree)
  function renderUnifiedSearchResults(rawQuery) {
    const sidebarContainer = document.getElementById('sidebarFolderListContainer');
    const dropdownContainer = document.getElementById('searchDropdownContainer');

    const hiraQuery = toHiragana(rawQuery);

    // Search Curriculum Words
    let curFiltered = vocabList.map(c => {
      const score = calculateSearchRelevance(c, rawQuery, hiraQuery);
      return { card: c, score };
    }).filter(item => item.score > 0);

    // Search Dictionary Words
    const dictSource = window.DICT_DATA || [];
    const exMap = window.DICT_EXAMPLES_MAP || {};
    const knownWords = new Set(vocabList.map(c => c.word));

    let dictFiltered = [];
    for (let idx = 0; idx < dictSource.length; idx++) {
      const entry = dictSource[idx];
      if (knownWords.has(entry.w)) continue;

      const w = (entry.w || '').toLowerCase();
      const r = (entry.r || '').toLowerCase();
      const mList = (entry.m || []).join(' ').toLowerCase();
      const zhList = (entry.zh || []).join(' ').toLowerCase();
      const frList = (entry.fr || []).join(' ').toLowerCase();

      if (
        w.includes(rawQuery) ||
        r.includes(rawQuery) ||
        w.includes(hiraQuery) ||
        r.includes(hiraQuery) ||
        mList.includes(rawQuery) ||
        zhList.includes(rawQuery) ||
        frList.includes(rawQuery)
      ) {
        const matchedEx = exMap[entry.w] || (entry.r ? exMap[entry.r] : null);
        const dictCard = {
          id: `dict_${entry.w}_${idx}`,
          word: entry.w,
          reading: entry.r || entry.w,
          category: entry.l ? `JLPT ${entry.l}` : '辞書',
          section_title: '日本語大辞書',
          meaning: {
            en: (entry.m && entry.m.join(', ')) || '—',
            zh_TW: (entry.zh && entry.zh.join(', ')) || (entry.m && entry.m.join(', ')) || '—',
            zh_CN: (entry.zh && entry.zh.join(', ')) || (entry.m && entry.m.join(', ')) || '—',
            ko: (entry.m && entry.m.join(', ')) || '—',
            zh_HK: (entry.zh && entry.zh.join(', ')) || (entry.m && entry.m.join(', ')) || '—',
            fr: (entry.fr && entry.fr.join(', ')) || (entry.m && entry.m.join(', ')) || '—'
          },
          example: {
            ja: matchedEx ? matchedEx.ja : '',
            en: matchedEx ? (matchedEx.en || '') : ''
          },
          related: `【品詞】${entry.p || '一般'} / 【JLPT】${entry.l || '一般'}`,
          isDict: true
        };
        const score = calculateSearchRelevance(dictCard, rawQuery, hiraQuery);
        dictFiltered.push({ card: dictCard, score });
        if (dictFiltered.length >= 120) break; // Keep search fast
      }
    }

    // Combine and sort strictly by relevance score descending
    const allScored = [...curFiltered, ...dictFiltered];
    allScored.sort((a, b) => b.score - a.score);

    const results = allScored.map(item => item.card);

    // Save previous scroll position of dropdown before re-rendering
    const prevScrollTop = dropdownContainer ? dropdownContainer.scrollTop : 0;

    // Build DOM elements for a given container
    function populateContainer(targetDom, isDropdown = false) {
      if (!targetDom) return;
      targetDom.innerHTML = '';

      const summaryHeader = document.createElement('div');
      summaryHeader.className = 'px-2 py-1 text-[11px] font-bold text-slate-500 flex items-center justify-between border-b border-slate-100 pb-1.5';
      summaryHeader.innerHTML = `
        <div class="flex items-center space-x-1">
          <span>${currentLang === 'ja' ? '検索結果' : 'Search Results'}: <strong class="text-coralPink font-extrabold">${results.length}</strong> ${currentLang === 'ja' ? '件' : 'words'}</span>
        </div>
        <div class="flex items-center space-x-2">
          <span class="text-[10px] text-slate-400 hidden sm:inline">${currentLang === 'ja' ? 'タップで詳細・学習' : 'Tap to study'}</span>
          <button class="btn-close-dropdown px-2 py-0.5 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-600 text-[10px] font-bold flex items-center space-x-1 transition">
            <i data-lucide="x" class="w-3 h-3"></i>
            <span>${currentLang === 'ja' ? '閉じる' : 'Close'}</span>
          </button>
        </div>
      `;
      const btnCloseDrop = summaryHeader.querySelector('.btn-close-dropdown');
      if (btnCloseDrop) {
        btnCloseDrop.addEventListener('click', (e) => {
          e.stopPropagation();
          const topSearch = document.getElementById('globalTopSearchInput');
          const clearTopBtn = document.getElementById('btnClearTopSearch');
          const dropdown = document.getElementById('searchDropdownContainer');
          if (topSearch) topSearch.value = '';
          if (clearTopBtn) clearTopBtn.classList.add('hidden');
          if (dropdown) dropdown.classList.add('hidden');
          sidebarSearchQuery = '';
          if (isSearchStudyMode) {
            backToFolderOverview();
          }
        });
      }
      targetDom.appendChild(summaryHeader);

      if (results.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'text-center py-8 text-slate-400 text-xs';
        emptyDiv.innerHTML = `
          <i data-lucide="search-x" class="w-6 h-6 mx-auto mb-1 text-slate-300"></i>
          <p>${currentLang === 'ja' ? '一致する単語が見つかりませんでした' : 'No matching words found'}</p>
        `;
        targetDom.appendChild(emptyDiv);
        lucide.createIcons({ root: targetDom });
        return;
      }

      results.slice(0, 100).forEach(card => {
        const isStarred = mylistSet.has(card.id) || mylistSet.has(card.word);
        const isExpanded = expandedWordId === card.id;

        const itemCard = document.createElement('div');
        itemCard.className = `rounded-2xl border transition-all overflow-hidden ${
          isExpanded
            ? 'bg-blue-50/50 border-deepNavy shadow-xs'
            : 'bg-white border-slate-100 hover:border-softBorder hover:bg-slate-50'
        }`;

        const targetMeaning = getBilingualMeaning(card.meaning, currentLang);
        const targetExTrans = getBilingualExampleTrans(card.example, currentLang);

        itemCard.innerHTML = `
          <div class="search-item-header p-2.5 flex items-center justify-between cursor-pointer select-none">
            <div class="flex-1 min-w-0 pr-2 pointer-events-none">
              <div class="flex items-baseline space-x-1.5">
                <span class="text-xs sm:text-sm font-bold text-darkNavyText">${card.word}</span>
                ${card.reading && card.reading !== card.word ? `<span class="text-[11px] text-slate-400">（${card.reading}）</span>` : ''}
                ${card.category ? `<span class="text-[9px] px-1.5 py-0.2 rounded-full font-bold ${card.isDict ? 'bg-slate-100 text-slate-600' : 'bg-lightBlueBg text-deepNavy'}">${card.category}</span>` : ''}
              </div>
              <p class="text-[11px] text-slate-600 font-medium truncate mt-0.5">${targetMeaning}</p>
            </div>
            <div class="flex items-center space-x-1 shrink-0">
              <button class="btn-play-card p-1.5 rounded-full hover:bg-slate-100 text-deepNavy transition" title="${currentLang === 'ja' ? 'カードで学習' : 'Study Card'}">
                <i data-lucide="play" class="w-3.5 h-3.5 fill-deepNavy"></i>
              </button>
              <button class="btn-search-star p-1.5 rounded-full hover:bg-slate-100 text-slate-300 hover:text-amber-400 transition" title="マイリスト">
                <i data-lucide="star" class="w-3.5 h-3.5 ${isStarred ? 'fill-amber-400 text-amber-400' : ''}"></i>
              </button>
              <div class="p-1 rounded-full text-slate-400">
                <i data-lucide="${isExpanded ? 'chevron-up' : 'chevron-down'}" class="w-3.5 h-3.5"></i>
              </div>
            </div>
          </div>

          <div class="${isExpanded ? 'block' : 'hidden'} px-3 pb-3 pt-1 border-t border-softBorder/60 bg-white/80 space-y-2">
            <div class="rounded-xl p-2 bg-lightBlueBg/30 border border-softBorder/50 flex items-center justify-between">
              <div>
                <span class="text-[10px] font-bold text-deepNavy uppercase block mb-0.5">${currentLang === 'ja' ? '意味・訳' : 'Meaning / Translation'}</span>
                <p class="text-xs sm:text-sm font-bold text-darkNavyText">${targetMeaning}</p>
              </div>
              <button class="btn-audio-word p-1 rounded-full bg-deepNavy text-white hover:opacity-90 shadow-2xs" title="音声">
                <i data-lucide="volume-2" class="w-3.5 h-3.5"></i>
              </button>
            </div>

            ${card.example && card.example.ja ? `
              <div class="rounded-xl p-2 bg-slate-50 border border-slate-200">
                <div class="flex items-center justify-between mb-1">
                  <span class="text-[10px] font-bold text-slate-600 flex items-center space-x-1">
                    <i data-lucide="message-square" class="w-3 h-3 text-deepNavy"></i>
                    <span>${currentLang === 'ja' ? '例文' : 'Example'}</span>
                  </span>
                  <button class="btn-audio-example text-deepNavy hover:opacity-80 p-0.5" title="例文音声">
                    <i data-lucide="volume-2" class="w-3 h-3"></i>
                  </button>
                </div>
                <p class="text-xs font-semibold text-slate-800 leading-relaxed mb-1">${card.example.ja}</p>
                ${targetExTrans ? `<p class="text-[10px] text-slate-500 leading-snug">${targetExTrans}</p>` : ''}
              </div>
            ` : ''}

            ${card.related ? `
              <div class="rounded-xl p-2 bg-slate-50 border border-slate-200 text-[10px] text-slate-700 leading-relaxed font-medium">
                <span class="font-bold text-slate-600 block mb-0.5">${currentLang === 'ja' ? '活用形・情報' : 'Related / Conjugations'}</span>
                ${card.related.replace(/\n/g, '<br/>')}
              </div>
            ` : ''}

            <div class="pt-1 flex items-center justify-end">
              <button class="btn-study-this-card px-3 py-1 rounded-full bg-deepNavy text-white font-bold text-[11px] shadow-2xs hover:opacity-90 flex items-center space-x-1 transition">
                <i data-lucide="play" class="w-3 h-3 fill-white"></i>
                <span>${currentLang === 'ja' ? 'この単語をカードで練習する' : 'Study this card'}</span>
              </button>
            </div>
          </div>
        `;

        lucide.createIcons({ root: itemCard });

        // Toggling accordion on clicking card header (excluding explicit buttons)
        const itemHeader = itemCard.querySelector('.search-item-header');
        if (itemHeader) {
          itemHeader.addEventListener('click', (e) => {
            // Ignore if clicked on play button or star button
            if (e.target.closest('.btn-play-card') || e.target.closest('.btn-search-star')) {
              return;
            }
            e.stopPropagation();
            expandedWordId = (expandedWordId === card.id) ? null : card.id;
            renderUnifiedSearchResults(rawQuery);
          });
        }

        // Voice audio buttons
        const audioWordBtn = itemCard.querySelector('.btn-audio-word');
        if (audioWordBtn) {
          audioWordBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleJapaneseSpeech(card);
          });
        }
        const audioExBtn = itemCard.querySelector('.btn-audio-example');
        if (audioExBtn && card.example && card.example.ja) {
          audioExBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleJapaneseSpeech(card.example.ja);
          });
        }

        // Study this card directly in flashcards view
        const studyCardHandler = (e) => {
          e.stopPropagation();
          // Hide dropdown if open
          if (dropdownContainer) dropdownContainer.classList.add('hidden');
          // Switch activeDeck to focus on this card
          isSearchStudyMode = true;
          activeDeck = [card];
          currentIndex = 0;
          switchView('flashcards');
          document.getElementById('folderOverviewPanel').classList.add('hidden');
          document.getElementById('unitListPanel').classList.add('hidden');
          document.getElementById('activeStudyHeader').classList.remove('hidden');
          document.getElementById('activeStudySectionName').textContent = card.word;
          document.getElementById('activeStudyFolderName').textContent = card.category || (currentLang === 'ja' ? '検索単語' : 'Search Word');
          renderCurrentCard();
          showToast(currentLang === 'ja' ? `「${card.word}」のカードを表示しました（←で一覧に戻れます）` : `Loaded "${card.word}" flashcard (Tap ← to go back)`);
        };

        const playBtn = itemCard.querySelector('.btn-play-card');
        if (playBtn) playBtn.addEventListener('click', studyCardHandler);
        const studyThisBtn = itemCard.querySelector('.btn-study-this-card');
        if (studyThisBtn) studyThisBtn.addEventListener('click', studyCardHandler);

        // Star toggle
        const starBtn = itemCard.querySelector('.btn-search-star');
        if (starBtn) {
          starBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            promptFolderSelectAndAdd(card, () => {
              renderUnifiedSearchResults(rawQuery);
            });
          });
        }

        targetDom.appendChild(itemCard);
      });
    }

    // Populate Sidebar
    if (sidebarContainer) {
      populateContainer(sidebarContainer, false);
    }

    // Populate Dropdown under search input and show it
    if (dropdownContainer) {
      dropdownContainer.classList.remove('hidden');
      populateContainer(dropdownContainer, true);
      // Restore previous scroll position so user doesn't lose place when expanding/collapsing
      if (prevScrollTop > 0) {
        dropdownContainer.scrollTop = prevScrollTop;
      }
    }
  }

  // --- PC / Mobile Layout (Responsive 2-Column on Desktop, Centered on Mobile) ---
  function initLayoutMode() {
    const sidebar = document.getElementById('vocabSidebar');
    const mainContainer = document.getElementById('mainContainer');

    function applyLayout() {
      const isDesktop = window.innerWidth >= 768;
      if (isDesktop) {
        if (sidebar) sidebar.classList.remove('hidden');
        if (mainContainer) mainContainer.className = 'flex-1 w-full max-w-5xl mx-auto p-3 sm:p-4 transition-all';
      } else {
        if (sidebar) sidebar.classList.add('hidden');
        if (mainContainer) mainContainer.className = 'flex-1 w-full max-w-md mx-auto p-3 sm:p-4 transition-all';
      }
    }

    applyLayout();
    window.addEventListener('resize', applyLayout);
  }

  function setStudent(student) {
    currentStudent = student;
    const drawerName = document.getElementById('drawerStudentName');
    const drawerStatus = document.getElementById('drawerStudentStatus');
    const drawerBtnLogin = document.getElementById('drawerBtnLogin');
    const drawerBtnLogout = document.getElementById('drawerBtnLogout');
    const btnLoginLogout = document.getElementById('btnLoginLogout');

    if (student) {
      localStorage.setItem('haku_current_student_id', student.id);
      document.getElementById('headerStudentBadge').textContent = `Student: ${student.name}`;
      // Update drawer student display
      if (drawerName) drawerName.textContent = student.name;
      if (drawerStatus) drawerStatus.textContent = 'Logged In';
      if (drawerBtnLogin) drawerBtnLogin.textContent = 'Switch ID';
      if (drawerBtnLogout) drawerBtnLogout.classList.remove('hidden');
      if (btnLoginLogout) btnLoginLogout.classList.remove('hidden');

      // Auto-switch language based on student profile!
      currentLang = student.lang || 'en';
      const drawerLangSelect = document.getElementById('drawerLangSelect');
      if (drawerLangSelect) drawerLangSelect.value = currentLang;

      showToast(`Logged in as ${student.name}`);

      // Authenticate with Firebase in background & sync latest cloud data
      ensureStudentCloudAuth(student.id, student.passcode).then(() => {
        syncStudentFromCloud(student.id);
      });
    } else {
      localStorage.removeItem('haku_current_student_id');
      document.getElementById('headerStudentBadge').textContent = 'Student: Guest';
      if (drawerName) drawerName.textContent = 'Guest';
      if (drawerStatus) drawerStatus.textContent = 'Not logged in';
      if (drawerBtnLogin) drawerBtnLogin.textContent = 'Log In';
      if (drawerBtnLogout) drawerBtnLogout.classList.add('hidden');
      if (btnLoginLogout) btnLoginLogout.classList.add('hidden');
      if (fbAuth && fbAuth.currentUser) {
        fbAuth.signOut().catch(() => {});
      }
    }
    loadMylistForCurrentStudent();
    applyUiLanguage(currentLang);
    updateActiveDeck();
  }

  let mylistFolders = []; // array of { id, name }
  let mylistCardFolderMap = {}; // cardId -> folderId (or null for root/unfiled)
  let activeMylistFolderId = 'all'; // 'all' or folderId

  function loadMylistForCurrentStudent() {
    const studentPrefix = currentStudent ? currentStudent.id : 'guest';
    const key = `haku_mylist_${studentPrefix}`;
    const foldersKey = `haku_mylist_folders_${studentPrefix}`;
    const mapKey = `haku_mylist_card_map_${studentPrefix}`;

    const saved = localStorage.getItem(key);
    mylistSet = new Set(saved ? JSON.parse(saved) : []);

    const savedFolders = localStorage.getItem(foldersKey);
    mylistFolders = savedFolders ? JSON.parse(savedFolders) : [];

    // Ensure the default folders are always present for every student:
    // 1. "授業で習った言葉" (folder_class_words)
    // 2. "覚えた！" (folder_learned)
    // 3. "もう一度！" (folder_review)
    const CLASS_FOLDER_ID = 'folder_class_words';
    const CLASS_FOLDER_NAME = '授業で習った言葉';
    const LEARNED_FOLDER_ID = 'folder_learned';
    const LEARNED_FOLDER_NAME = '覚えた！';
    const REVIEW_FOLDER_ID = 'folder_review';
    const REVIEW_FOLDER_NAME = 'もう一度！';

    let foldersUpdated = false;
    if (!mylistFolders.find(f => f.id === CLASS_FOLDER_ID || f.name === CLASS_FOLDER_NAME)) {
      mylistFolders.unshift({ id: CLASS_FOLDER_ID, name: CLASS_FOLDER_NAME });
      foldersUpdated = true;
    }
    if (!mylistFolders.find(f => f.id === LEARNED_FOLDER_ID || f.name === LEARNED_FOLDER_NAME)) {
      mylistFolders.push({ id: LEARNED_FOLDER_ID, name: LEARNED_FOLDER_NAME });
      foldersUpdated = true;
    }
    if (!mylistFolders.find(f => f.id === REVIEW_FOLDER_ID || f.name === REVIEW_FOLDER_NAME)) {
      mylistFolders.push({ id: REVIEW_FOLDER_ID, name: REVIEW_FOLDER_NAME });
      foldersUpdated = true;
    }
    if (foldersUpdated) {
      localStorage.setItem(foldersKey, JSON.stringify(mylistFolders));
    }

    const savedMap = localStorage.getItem(mapKey);
    mylistCardFolderMap = savedMap ? JSON.parse(savedMap) : {};

    // Exact Google Doc Tab Word Mappings per Student
    // 1: みどりさん (0012) -> class_word_0001 ~ class_word_0289 (289 words)
    // 2: Keyvinさん (0011) -> class_word_0290 ~ class_word_0498 (209 words)
    // 3: ななさん (0013) -> class_word_0499 ~ class_word_0538 (40 words)
    // 4: Danielさん (0014) -> class_word_0539 ~ class_word_0639 (101 words)
    // 5: Stephenさん (0015) -> class_word_0640 ~ class_word_0873 (234 words)
    // 6: ジウンさん (0016) -> class_word_0874 ~ class_word_1144 (271 words)
    // 7: ハンウさん (0017) -> class_word_1145 ~ class_word_1213 (69 words)
    // 8: Justinさん (0018) -> class_word_1214 ~ class_word_1232 (19 words)
    // 9: ミンギさん (0019) -> class_word_1233 ~ class_word_1314 (82 words)
    // 10: Colinさん (0020) -> class_word_1315 ~ class_word_1397 (83 words)
    // 11: ともやさん (0021) -> class_word_1398 ~ class_word_1598 (201 words)
    // 12: 生徒22 (0022) -> class_word_1599 ~ class_word_1602 (追加語彙)
    const STUDENT_DOC_RANGES = {
      '0012': [1, 289],
      '0011': [290, 498],
      '0013': [499, 538],
      '0014': [539, 639],
      '0015': [640, 873],
      '0016': [874, 1144],
      '0017': [1145, 1213],
      '0018': [1214, 1232],
      '0019': [1233, 1314],
      '0020': [1315, 1397],
      '0021': [1398, 1598],
      '0022': [1599, 1602]
    };

    const studentRange = STUDENT_DOC_RANGES[studentPrefix];
    if (studentRange) {
      let needsSave = false;
      const [startNum, endNum] = studentRange;
      for (let num = startNum; num <= endNum; num++) {
        const cId = `class_word_${String(num).padStart(4, '0')}`;
        if (!mylistSet.has(cId)) {
          mylistSet.add(cId);
          needsSave = true;
        }
        if (!mylistCardFolderMap[cId]) {
          mylistCardFolderMap[cId] = CLASS_FOLDER_ID;
          needsSave = true;
        }
      }
      if (needsSave) {
        localStorage.setItem(key, JSON.stringify(Array.from(mylistSet)));
        localStorage.setItem(mapKey, JSON.stringify(mylistCardFolderMap));
      }
    } else if (studentPrefix === '0023' && window.CLASS_ARUN_IDS) {
      let needsSave = false;
      window.CLASS_ARUN_IDS.forEach(cId => {
        if (!mylistSet.has(cId)) {
          mylistSet.add(cId);
          needsSave = true;
        }
        if (!mylistCardFolderMap[cId]) {
          mylistCardFolderMap[cId] = CLASS_FOLDER_ID;
          needsSave = true;
        }
      });
      if (needsSave) {
        localStorage.setItem(key, JSON.stringify(Array.from(mylistSet)));
        localStorage.setItem(mapKey, JSON.stringify(mylistCardFolderMap));
      }
    }

    updateMylistBadge();
  }

  // --- Firebase Cloud Sync Core ---
  // Authenticates student behind the scenes using internal virtual email (e.g. 0001@haku.local)
  // This satisfies Gemini's security rule: request.auth.token.email == studentId + '@haku.local'
  async function ensureStudentCloudAuth(studentId, passcode) {
    if (!isFirebaseReady || !fbAuth || !studentId || studentId === 'guest') return false;
    const virtualEmail = `${studentId.toLowerCase()}@haku.local`;
    const passwordStr = `haku_${passcode}_sec`;

    try {
      if (fbAuth.currentUser && fbAuth.currentUser.email === virtualEmail) {
        return true;
      }
      // Try sign in
      try {
        await fbAuth.signInWithEmailAndPassword(virtualEmail, passwordStr);
        return true;
      } catch (signInErr) {
        if (signInErr.code === 'auth/user-not-found' || signInErr.code === 'auth/invalid-credential' || signInErr.code === 'auth/wrong-password') {
          // Create user account if not exists
          try {
            await fbAuth.createUserWithEmailAndPassword(virtualEmail, passwordStr);
            return true;
          } catch (createErr) {
            // If already exists or error, try sign in once more
            console.warn('Firebase user creation note:', createErr.message);
          }
        }
      }
    } catch (err) {
      console.warn('Firebase student auth note:', err.message);
    }
    return !!fbAuth.currentUser;
  }

  // Push student's mylist, folders, and mapping to Cloud Firestore
  async function syncStudentToCloud(studentId) {
    if (!isFirebaseReady || !fbDb || !studentId || studentId === 'guest') return;
    try {
      // Ensure user is authenticated first so Firestore security rule passes
      if (currentStudent && currentStudent.id === studentId) {
        await ensureStudentCloudAuth(studentId, currentStudent.passcode);
      }
      // Gather any card objects that this student has in their mylist and aren't in INITIAL_VOCAB_DATA or CLASS_VOCAB_DATA
      const seedIds = new Set((window.INITIAL_VOCAB_DATA || []).map(c => c.id));
      const classIds = new Set((window.CLASS_VOCAB_DATA || []).map(c => c.id));
      const customCardsToSync = [];
      mylistSet.forEach(cId => {
        if (!seedIds.has(cId) && !classIds.has(cId) && !cId.startsWith('class_word_')) {
          const resolvedCard = getCardById(cId);
          if (resolvedCard) customCardsToSync.push(resolvedCard);
        }
      });

      const docRef = fbDb.collection('students').doc(studentId);
      await docRef.set({
        mylist: Array.from(mylistSet),
        folders: mylistFolders,
        cardFolderMap: mylistCardFolderMap,
        customCards: customCardsToSync,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      console.log(`Cloud sync pushed for student ${studentId} ☁️`);
    } catch (err) {
      console.warn('Cloud sync push note:', err.message);
    }
  }

  // Pull student's mylist, folders, and mapping from Cloud Firestore
  async function syncStudentFromCloud(studentId) {
    if (!isFirebaseReady || !fbDb || !studentId || studentId === 'guest') return false;
    try {
      // Ensure user is authenticated first
      if (currentStudent && currentStudent.id === studentId) {
        await ensureStudentCloudAuth(studentId, currentStudent.passcode);
      }
      const docRef = fbDb.collection('students').doc(studentId);
      const snap = await docRef.get();
      if (snap.exists) {
        const data = snap.data();
        let changed = false;

        // 1. Sync custom card definitions (e.g. newly imported cards from PC)
        if (Array.isArray(data.customCards) && data.customCards.length > 0) {
          let vocabChanged = false;
          const classIds = new Set((window.CLASS_VOCAB_DATA || []).map(c => c.id));
          const seedIds = new Set((window.INITIAL_VOCAB_DATA || []).map(c => c.id));
          data.customCards.forEach(card => {
            if (card && card.id && !classIds.has(card.id) && !seedIds.has(card.id) && !card.id.startsWith('class_word_')) {
              const exists = vocabList.find(c => c.id === card.id);
              if (!exists) {
                card.isCustom = true;
                vocabList.push(card);
                vocabChanged = true;
              }
            }
          });
          if (vocabChanged) {
            localStorage.setItem('haku_vocab_data', JSON.stringify(vocabList));
            changed = true;
          }
        }

        // 2. Sync mylist IDs
        if (Array.isArray(data.mylist)) {
          data.mylist.forEach(id => {
            if (!mylistSet.has(id)) {
              mylistSet.add(id);
              changed = true;
            }
          });
        }

        // 3. Sync custom folders
        if (Array.isArray(data.folders) && data.folders.length > 0) {
          data.folders.forEach(f => {
            if (!mylistFolders.find(ex => ex.id === f.id)) {
              mylistFolders.push(f);
              changed = true;
            }
          });
        }

        // 4. Sync card to folder mapping
        if (data.cardFolderMap && typeof data.cardFolderMap === 'object') {
          Object.assign(mylistCardFolderMap, data.cardFolderMap);
          changed = true;
        }

        if (changed) {
          // Update local cache
          const key = `haku_mylist_${studentId}`;
          const foldersKey = `haku_mylist_folders_${studentId}`;
          const mapKey = `haku_mylist_card_map_${studentId}`;
          localStorage.setItem(key, JSON.stringify(Array.from(mylistSet)));
          localStorage.setItem(foldersKey, JSON.stringify(mylistFolders));
          localStorage.setItem(mapKey, JSON.stringify(mylistCardFolderMap));
          console.log(`Cloud data successfully synced down for ${studentId}! ☁️✨`);
        }
        updateMylistBadge();
        const mylistViewElem = document.getElementById('viewMylist');
        if (mylistViewElem && !mylistViewElem.classList.contains('hidden')) {
          renderMylistView();
        }
        return changed;
      }
    } catch (err) {
      console.warn('Cloud sync pull note:', err.message);
    }
    return false;
  }

  function saveMylistForCurrentStudent() {
    const studentPrefix = currentStudent ? currentStudent.id : 'guest';
    const key = `haku_mylist_${studentPrefix}`;
    const foldersKey = `haku_mylist_folders_${studentPrefix}`;
    const mapKey = `haku_mylist_card_map_${studentPrefix}`;

    localStorage.setItem(key, JSON.stringify(Array.from(mylistSet)));
    localStorage.setItem(foldersKey, JSON.stringify(mylistFolders));
    localStorage.setItem(mapKey, JSON.stringify(mylistCardFolderMap));

    updateMylistBadge();

    // Trigger asynchronous cloud sync to persist on all devices!
    if (currentStudent && currentStudent.id !== 'guest') {
      syncStudentToCloud(currentStudent.id);
    }
  }

  // --- Folder Picker Modal for Adding Cards to My List ---
  function promptFolderSelectAndAdd(card, onComplete) {
    // If already in mylist, toggle off directly
    if (mylistSet.has(card.id)) {
      mylistSet.delete(card.id);
      delete mylistCardFolderMap[card.id];
      saveMylistForCurrentStudent();
      showToast(currentLang === 'ja' ? `「${card.word}」をマイリストから解除しました` : `Removed "${card.word}" from My List`);
      if (onComplete) onComplete(false);
      return;
    }

    // Existing folders
    const CLASS_FOLDER_ID = 'folder_class_words';
    const CLASS_FOLDER_NAME = '授業で習った言葉';
    if (!mylistFolders.find(f => f.id === CLASS_FOLDER_ID || f.name === CLASS_FOLDER_NAME)) {
      mylistFolders.unshift({ id: CLASS_FOLDER_ID, name: CLASS_FOLDER_NAME });
    }

    // Build modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 animate-fade-in';
    
    let folderOptionsButtons = `
      <button data-folder-id="" class="w-full text-left px-3.5 py-2.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 flex items-center justify-between text-xs font-bold text-slate-700 transition">
        <span class="flex items-center space-x-2"><span>📂</span><span>${currentLang === 'ja' ? 'フォルダ指定なし（未分類）' : 'Unfiled (No folder)'}</span></span>
        <span class="text-[10px] text-slate-400">Default</span>
      </button>
    `;

    mylistFolders.forEach(f => {
      folderOptionsButtons += `
        <button data-folder-id="${f.id}" class="w-full text-left px-3.5 py-2.5 rounded-xl border border-softBorder bg-white hover:bg-lightBlueBg/40 flex items-center justify-between text-xs font-bold text-deepNavy transition">
          <span class="flex items-center space-x-2"><span>📁</span><span>${f.name}</span></span>
          <i data-lucide="chevron-right" class="w-3.5 h-3.5 text-slate-400"></i>
        </button>
      `;
    });

    overlay.innerHTML = `
      <div class="bg-white rounded-3xl p-5 max-w-sm w-full shadow-2xl border border-softBorder space-y-4 animate-scale-up" onclick="event.stopPropagation()">
        <div class="flex items-center justify-between border-b border-slate-100 pb-3">
          <div>
            <h3 class="text-sm font-bold text-deepNavy flex items-center space-x-1.5">
              <span>⭐</span>
              <span>${currentLang === 'ja' ? 'マイリストの保存先フォルダ' : 'Choose Folder'}</span>
            </h3>
            <p class="text-[11px] text-slate-500 mt-0.5">${currentLang === 'ja' ? `「${card.word}」の保存先を選択してください` : `Save "${card.word}" into:`}</p>
          </div>
          <button class="btn-close-modal p-1.5 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-100 transition">
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
        </div>

        <div class="space-y-2 max-h-60 overflow-y-auto pr-1">
          ${folderOptionsButtons}
        </div>

        <div class="pt-2 border-t border-slate-100">
          <button class="btn-cancel-modal w-full py-2 rounded-xl text-xs font-bold text-slate-500 hover:bg-slate-100 transition">
            ${currentLang === 'ja' ? 'キャンセル' : 'Cancel'}
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    if (window.lucide) lucide.createIcons({ root: overlay });

    const closeModal = () => {
      overlay.classList.add('opacity-0');
      setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }, 150);
    };

    overlay.querySelector('.btn-close-modal').addEventListener('click', closeModal);
    overlay.querySelector('.btn-cancel-modal').addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    overlay.querySelectorAll('[data-folder-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const destFolderId = btn.getAttribute('data-folder-id') || null;
        mylistSet.add(card.id);
        if (destFolderId) {
          mylistCardFolderMap[card.id] = destFolderId;
        } else {
          delete mylistCardFolderMap[card.id];
        }
        saveMylistForCurrentStudent();

        const folderObj = mylistFolders.find(f => f.id === destFolderId);
        const folderName = folderObj ? folderObj.name : (currentLang === 'ja' ? '未分類' : 'Unfiled');
        showToast(currentLang === 'ja' ? `「${card.word}」を「${folderName}」に保存しました ⭐` : `Saved "${card.word}" to ${folderName} ⭐`);

        closeModal();
        if (onComplete) onComplete(true);
      });
    });
  }

  function updateMylistBadge() {
    const badge = document.getElementById('mylistCountBadge');
    if (badge) badge.textContent = mylistSet.size;
    const drawerBadge = document.getElementById('drawerMylistBadge');
    if (drawerBadge) drawerBadge.textContent = mylistSet.size;
  }

  // --- Sliding Menu Drawer Controls (2枚目画像スタイル) ---
  function openMenuDrawer() {
    const drawer = document.getElementById('portalDrawer');
    const overlay = document.getElementById('portalDrawerOverlay');
    if (!drawer || !overlay) return;

    overlay.classList.remove('hidden');
    // trigger reflow for smooth animation
    void overlay.offsetWidth;
    overlay.classList.remove('opacity-0');
    drawer.classList.remove('-translate-x-full');
  }

  function closeMenuDrawer() {
    const drawer = document.getElementById('portalDrawer');
    const overlay = document.getElementById('portalDrawerOverlay');
    if (!drawer || !overlay) return;

    overlay.classList.add('opacity-0');
    drawer.classList.add('-translate-x-full');
    setTimeout(() => {
      overlay.classList.add('hidden');
    }, 300);
  }

  let expandedOverviewFolderIds = new Set(); // tracks which folders are open in Level 1 overview

  function renderFolderOverview() {
    const container = document.getElementById('folderButtonsContainer');
    if (!container) return;
    container.innerHTML = '';

    const sectionsCatalog = window.SECTIONS_DATA || [];
    const sectionsMap = window.SECTIONS || {};

    FOLDER_CONFIGS.forEach(fc => {
      const isExpanded = expandedOverviewFolderIds.has(fc.id);
      const folderCards = vocabList.filter(c => c.folder_id === fc.id);
      const bilingualFolderTitle = getBilingualFolderTitle(fc, currentLang);

      // Wrapper matching Image 2: rounded-2xl border bg-white
      const folderWrapper = document.createElement('div');
      folderWrapper.className = 'border border-softBorder rounded-2xl bg-white shadow-2xs overflow-hidden transition-all';

      // Header row: [Folder icon] [初級 1-10 (262語)] ... [Play] [Check/Test] [Chevron]
      const headerDiv = document.createElement('div');
      headerDiv.className = 'px-3.5 py-3 hover:bg-slate-50 cursor-pointer flex items-center justify-between select-none transition';
      headerDiv.innerHTML = `
        <div class="flex items-center space-x-2.5 truncate pr-2">
          <i data-lucide="${isExpanded ? 'folder-open' : 'folder'}" class="w-5 h-5 text-deepNavy shrink-0"></i>
          <span class="text-sm font-bold text-darkNavyText truncate">${bilingualFolderTitle}</span>
          <span class="text-xs text-slate-400 font-medium shrink-0">(${folderCards.length}語)</span>
        </div>
        <div class="flex items-center space-x-2 shrink-0">
          <button class="btn-overview-play p-1 text-deepNavy hover:bg-slate-100 rounded-lg transition" title="このフォルダの全単語を学習">
            <i data-lucide="play" class="w-4 h-4 fill-deepNavy text-deepNavy"></i>
          </button>
          <button class="btn-overview-test p-1 text-emerald-600 hover:bg-slate-100 rounded-lg transition" title="このフォルダのテストを開始">
            <i data-lucide="check-circle-2" class="w-4 h-4 text-emerald-600"></i>
          </button>
          <button class="btn-overview-toggle p-0.5 text-slate-400 hover:text-deepNavy transition" title="${isExpanded ? '閉じる' : '開く'}">
            <i data-lucide="${isExpanded ? 'chevron-up' : 'chevron-down'}" class="w-4 h-4"></i>
          </button>
        </div>
      `;

      // Header click toggles open/close
      headerDiv.addEventListener('click', (e) => {
        if (e.target.closest('.btn-overview-play')) {
          e.stopPropagation();
          currentFolder = fc.id;
          startStudyingEntireFolder();
          return;
        }
        if (e.target.closest('.btn-overview-test')) {
          e.stopPropagation();
          currentFolder = fc.id;
          startQuizWithScope('folder', fc.id, fc.title);
          return;
        }

        // Toggle open/collapse
        if (expandedOverviewFolderIds.has(fc.id)) {
          expandedOverviewFolderIds.delete(fc.id);
        } else {
          expandedOverviewFolderIds.add(fc.id);
        }
        renderFolderOverview();
      });

      folderWrapper.appendChild(headerDiv);

      // Collapsible units list inside this folder
      if (isExpanded) {
        const unitsContainer = document.createElement('div');
        unitsContainer.className = 'py-1 px-2 space-y-1 border-t border-slate-100 bg-slate-50/50';

        const [minSec, maxSec] = fc.range;
        const secNumsToRender = [];
        if (fc.id === 'folder_1') {
          secNumsToRender.push(0);
        }
        for (let s = minSec; s <= maxSec; s++) {
          secNumsToRender.push(s);
        }

        secNumsToRender.forEach(secNum => {
          const catalogItem = sectionsCatalog.find(s => s.num === secNum);
          if (!catalogItem && !sectionsMap[secNum] && vocabList.filter(c => c.section_num === secNum).length === 0) {
            return;
          }
          const rawSecTitle = (catalogItem && catalogItem.title) || sectionsMap[secNum] || `${secNum}. 単元${secNum}`;
          const bilingualTitle = getBilingualSectionTitle(secNum, rawSecTitle, currentLang);
          const secCards = vocabList.filter(c => c.section_num === secNum);
          const numDisplay = secNum === 0 ? '★' : `${secNum}`;

          const isCurrentActive = (currentSection == secNum && currentFolder === fc.id);

          const unitItem = document.createElement('div');
          unitItem.className = `group flex items-center justify-between px-3 py-2 rounded-xl cursor-pointer transition text-xs ${
            isCurrentActive
              ? 'bg-lightBlueBg/80 border-2 border-deepNavy text-deepNavy font-bold shadow-xs'
              : 'bg-white border border-slate-200/80 hover:border-deepNavy hover:bg-blue-50/30 text-slate-800'
          }`;
          unitItem.innerHTML = `
            <div class="flex items-center space-x-2 truncate pr-2">
              <span class="w-5 h-5 rounded-md ${isCurrentActive ? 'bg-deepNavy text-white' : 'bg-slate-100 text-slate-700'} font-bold text-[10px] flex items-center justify-center shrink-0">${numDisplay}</span>
              <span class="truncate font-semibold text-xs">${bilingualTitle}</span>
            </div>
            <div class="flex items-center space-x-1 shrink-0 text-slate-400">
              <span class="text-[10px] px-1.5 py-0.5 rounded font-medium ${isCurrentActive ? 'bg-deepNavy text-white' : 'bg-slate-100 text-slate-600'}">${secCards.length}語</span>
              <i data-lucide="chevron-right" class="w-3.5 h-3.5 text-slate-300 group-hover:text-deepNavy transition"></i>
            </div>
          `;

          unitItem.addEventListener('click', (e) => {
            e.stopPropagation();
            currentFolder = fc.id;
            startStudyingSection(secNum, rawSecTitle);
          });

          unitsContainer.appendChild(unitItem);
        });

        folderWrapper.appendChild(unitsContainer);
      }

      container.appendChild(folderWrapper);
    });

    // Also populate mobile container if present
    const mobileContainer = document.getElementById('folderButtonsContainerMobile');
    if (mobileContainer && container !== mobileContainer) {
      mobileContainer.innerHTML = container.innerHTML;
    }

    lucide.createIcons({ root: container });
    if (mobileContainer) lucide.createIcons({ root: mobileContainer });
  }

  function openFolderUnits(folderId) {
    currentFolder = folderId;
    currentNavLevel = 'units';

    const fc = FOLDER_CONFIGS.find(f => f.id === folderId);
    const bilingualFolderTitle = getBilingualFolderTitle(fc, currentLang);
    document.getElementById('currentFolderTitle').textContent = fc ? bilingualFolderTitle : '単元一覧';

    const container = document.getElementById('unitButtonsContainer');
    container.innerHTML = '';

    const [minSec, maxSec] = fc.range;
    const sectionsCatalog = window.SECTIONS_DATA || [];
    const sectionsMap = window.SECTIONS || {};

    const secNumsToRender = [];
    if (folderId === 'folder_1') {
      secNumsToRender.push(0);
    }
    for (let s = minSec; s <= maxSec; s++) {
      secNumsToRender.push(s);
    }

    secNumsToRender.forEach(secNum => {
      const catalogItem = sectionsCatalog.find(s => s.num === secNum);
      if (!catalogItem && !sectionsMap[secNum] && vocabList.filter(c => c.section_num === secNum).length === 0) {
        return;
      }
      const rawSecTitle = (catalogItem && catalogItem.title) || sectionsMap[secNum] || `${secNum}. 単元${secNum}`;
      const bilingualTitle = getBilingualSectionTitle(secNum, rawSecTitle, currentLang);
      const secCards = vocabList.filter(c => c.section_num === secNum);
      const numDisplay = secNum === 0 ? '★' : `${secNum}`;

      const unitBtn = document.createElement('button');
      unitBtn.className = 'w-full p-2.5 rounded-xl border border-slate-200 bg-white hover:border-rose-300 hover:bg-rose-50/50 flex items-center justify-between text-left transition text-xs font-semibold text-slate-800 shadow-2xs';
      unitBtn.innerHTML = `
        <div class="flex items-center space-x-2 truncate pr-2">
          <span class="w-6 h-6 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center font-bold text-[11px] shrink-0">${numDisplay}</span>
          <span class="truncate">${bilingualTitle}</span>
        </div>
        <div class="flex items-center space-x-1 text-slate-400 shrink-0">
          <span class="text-[10px] bg-slate-100 px-1.5 py-0.5 rounded">${secCards.length}語</span>
          <i data-lucide="chevron-right" class="w-3.5 h-3.5"></i>
        </div>
      `;
      lucide.createIcons({ root: unitBtn });

      unitBtn.addEventListener('click', () => {
        startStudyingSection(secNum, rawSecTitle);
      });
      container.appendChild(unitBtn);
    });

    // Toggle panels
    document.getElementById('folderOverviewPanel').classList.add('hidden');
    document.getElementById('unitListPanel').classList.remove('hidden');
    document.getElementById('activeStudyHeader').classList.add('hidden');
  }

  function startStudyingSection(sectionNum, sectionTitle) {
    currentSection = sectionNum;
    currentNavLevel = 'study';

    // Update active study header with bilingual titles
    const fc = FOLDER_CONFIGS.find(f => f.id === currentFolder);
    const bilingualSec = getBilingualSectionTitle(sectionNum, sectionTitle, currentLang);
    const bilingualFold = getBilingualFolderTitle(fc, currentLang);
    document.getElementById('activeStudySectionName').textContent = bilingualSec;
    document.getElementById('activeStudyFolderName').textContent = fc ? bilingualFold : '';

    // Switch panels
    document.getElementById('folderOverviewPanel').classList.add('hidden');
    document.getElementById('unitListPanel').classList.add('hidden');
    document.getElementById('activeStudyHeader').classList.remove('hidden');

    updateActiveDeck();
    renderFolderOverview();
    showToast(`「${sectionTitle}」の学習を開始します`);
  }

  function startStudyingEntireFolder() {
    currentSection = 'all';
    currentNavLevel = 'study';

    const fc = FOLDER_CONFIGS.find(f => f.id === currentFolder);
    document.getElementById('activeStudySectionName').textContent = fc ? `${fc.title} (全単元)` : 'フォルダ全体';
    document.getElementById('activeStudyFolderName').textContent = '全単語';

    document.getElementById('folderOverviewPanel').classList.add('hidden');
    document.getElementById('unitListPanel').classList.add('hidden');
    document.getElementById('activeStudyHeader').classList.remove('hidden');

    updateActiveDeck();
    showToast(`${fc ? fc.title : 'このフォルダ'}の全単語を学習します`);
  }

  function backToFolderOverview() {
    currentNavLevel = 'folders';
    isSearchStudyMode = false;
    document.getElementById('folderOverviewPanel').classList.remove('hidden');
    document.getElementById('unitListPanel').classList.add('hidden');
    document.getElementById('activeStudyHeader').classList.add('hidden');
    // Restore default deck so flashcards are not stuck on the search single card
    updateActiveDeck();
  }

  function updateActiveDeck() {
    let pool = vocabList.filter(card => {
      // Shared vs Student dedicated
      if (currentDeckFilter === 'mine') {
        if (!currentStudent) return false;
        return card.studentId === currentStudent.id;
      } else {
        return !card.studentId || card.studentId === 'all';
      }
    });

    // Filter by Folder
    if (currentFolder !== 'all') {
      pool = pool.filter(card => card.folder_id === currentFolder);
    }

    // Filter by Section
    if (currentSection !== 'all') {
      pool = pool.filter(card => card.section_num == currentSection);
    }

    activeDeck = pool;
    currentIndex = 0;
    isCardFlipped = false;
    renderCurrentCard();
  }

  // --- 3D Card Rendering & Interaction ---
  function renderCurrentCard() {
    const cardEl = document.getElementById('flashcardElement');
    if (!cardEl) return;

    // Reset flip animation
    isCardFlipped = false;
    cardEl.classList.remove('rotate-y-180');

    if (!activeDeck || activeDeck.length === 0) {
      document.getElementById('cardProgressText').textContent = '0 / 0';
      document.getElementById('frontWord').textContent = 'カードがありません';
      document.getElementById('frontReading').textContent = '';
      document.getElementById('frontCategoryBadge').textContent = '空';
      document.getElementById('backMeaning').textContent = 'カードを追加してください';
      return;
    }

    if (currentIndex >= activeDeck.length) currentIndex = activeDeck.length - 1;
    if (currentIndex < 0) currentIndex = 0;

    const card = activeDeck[currentIndex];
    document.getElementById('cardProgressText').textContent = `${currentIndex + 1} / ${activeDeck.length}`;

    // Check Star / Mylist state
    const btnStar = document.getElementById('btnStarCurrent');
    if (mylistSet.has(card.id)) {
      btnStar.innerHTML = `<i data-lucide="star" class="w-5 h-5 fill-amber-400 text-amber-400"></i>`;
    } else {
      btnStar.innerHTML = `<i data-lucide="star" class="w-5 h-5 text-slate-300"></i>`;
    }
    lucide.createIcons({ root: btnStar });

    // Multi-language translation lookup (必ず母国語 & 英語)
    const targetMeaning = getBilingualMeaning(card.meaning, currentLang);
    const targetExTrans = getBilingualExampleTrans(card.example, currentLang);

    // Reverse Mode handling: 日本語 ⇄ 母国語
    if (!isReverseMode) {
      // Normal: Front is Japanese, Back is Native & English Meaning
      document.getElementById('frontWord').textContent = card.word;
      document.getElementById('frontReading').textContent = card.reading || '';
      document.getElementById('frontReading').classList.remove('hidden');
      document.getElementById('backMeaning').textContent = targetMeaning;
    } else {
      // Reverse: Front is Native & English Meaning, Back is Japanese
      document.getElementById('frontWord').textContent = targetMeaning;
      document.getElementById('frontReading').textContent = '';
      document.getElementById('frontReading').classList.add('hidden');
      document.getElementById('backMeaning').textContent = `${card.word} (${card.reading || ''})`;
    }

    document.getElementById('frontCategoryBadge').textContent = card.category || '一般';
    document.getElementById('backCategoryBadge').textContent = card.category || '一般';
    document.getElementById('backWordHeader').textContent = card.word;
    document.getElementById('backReadingHeader').textContent = card.reading ? `（${card.reading}）` : '';

    // Example sentence & Translation (Render HTML <ruby> tags for furigana and <br> for dialogues)
    if (card.example && card.example.ja) {
      document.getElementById('backExampleJa').innerHTML = card.example.ja;
      document.getElementById('backExampleTranslation').innerHTML = targetExTrans;
      document.getElementById('backExampleJa').parentElement.classList.remove('hidden');
      // ★ 例文から単語辞書ボタンチップを自動抽出して描画
      if (typeof renderExampleWordChips === 'function') {
        renderExampleWordChips(card.example.ja);
      }
    } else {
      document.getElementById('backExampleJa').parentElement.classList.add('hidden');
      const chipsCont = document.getElementById('exampleWordChipsContainer');
      if (chipsCont) chipsCont.classList.add('hidden');
    }

    // Related Words / Verb Conjugations (関連する言葉は日本語、説明は母国語)
    const relContainer = document.getElementById('backRelatedContainer');
    if (card.related && card.related.trim()) {
      relContainer.classList.remove('hidden');

      // Dictionary of linguistic terms for multilingual students
      const LINGUISTIC_TERMS = {
        '名詞': { en: 'Noun', zh_TW: '名詞', zh_CN: '名词', ko: '명사', zh_HK: '名詞', fr: 'Nom' },
        '動詞': { en: 'Verb', zh_TW: '動詞', zh_CN: '动词', ko: '동사', zh_HK: '動詞', fr: 'Verbe' },
        'い形容詞': { en: 'I-Adjective', zh_TW: 'い形容詞', zh_CN: 'い形容词', ko: 'い형용사', zh_HK: 'い形容詞', fr: 'Adjectif en -i' },
        'な形容詞': { en: 'Na-Adjective', zh_TW: 'な形容詞', zh_CN: 'な形容词', ko: 'な형용사', zh_HK: 'な形容詞', fr: 'Adjectif en -na' },
        '相槌': { en: 'Interjection / Backchannel', zh_TW: '附和語 / 應答', zh_CN: '附和语 / 应答', ko: '맞장구 / 리액션', zh_HK: '附和語 / 應答', fr: 'Interjection' },
        '場所': { en: 'Place / Facility', zh_TW: '場所 / 設施', zh_CN: '场所 / 设施', ko: '장소 / 시설', zh_HK: '場所 / 設施', fr: 'Lieu / Installation' },
        '代名詞': { en: 'Pronoun / Family', zh_TW: '代名詞 / 家族', zh_CN: '代名词 / 家族', ko: '대명사 / 가족', zh_HK: '代名詞 / 家族', fr: 'Pronom / Famille' },
        '文法': { en: 'Grammar', zh_TW: '文法', zh_CN: '语法', ko: '문법', zh_HK: '語法', fr: 'Grammaire' },
        '原型（辞書形）': { en: 'Dictionary Form', zh_TW: '原形（辭書形）', zh_CN: '原形（辞书形）', ko: '기본형 (사전형)', zh_HK: '原形（辭書形）', fr: 'Forme du dictionnaire' },
        'ます形': { en: 'Masu Form', zh_TW: 'ます形', zh_CN: 'ます形', ko: 'ます형 (정중형)', zh_HK: 'ます形', fr: 'Forme en -masu' },
        'て形': { en: 'Te Form', zh_TW: 'て形', zh_CN: 'て形', ko: 'て형 (연결형)', zh_HK: 'て形', fr: 'Forme en -te' },
        'ない形': { en: 'Nai Form', zh_TW: 'ない形', zh_CN: 'ない形', ko: 'ない형 (부정형)', zh_HK: 'ない形', fr: 'Forme en -nai' },
        'た形': { en: 'Ta Form', zh_TW: 'た形', zh_CN: 'た形', ko: 'た형 (과거형)', zh_HK: 'た形', fr: 'Forme en -ta' },
        'グループ・連語': { en: 'Group & Collocation', zh_TW: '分類與慣用搭配', zh_CN: '分类与惯用搭配', ko: '그룹 및 연어', zh_HK: '分類與慣用搭配', fr: 'Groupe & Collocation' },
        '日常会話の重要語彙': { en: 'Essential daily vocabulary', zh_TW: '日常會話重要語彙', zh_CN: '日常会话重要词汇', ko: '일상 회화 중요 어휘', zh_HK: '日常會話重要字詞', fr: 'Vocabulaire essentiel du quotidien' }
      };

      let formattedRelated = card.related;
      // Add native translation explanation if applicable and currentLang is not 'ja'
      if (currentLang !== 'ja') {
        formattedRelated = formattedRelated.split('\n').map(line => {
          let translatedSub = '';
          for (const [jpKey, transMap] of Object.entries(LINGUISTIC_TERMS)) {
            if (line.includes(`【${jpKey}】`) || line.includes(jpKey)) {
              translatedSub = transMap[currentLang] || transMap.en || '';
              break;
            }
          }
          if (translatedSub) {
            return `${line} <span class="text-[10px] text-slate-400 font-normal">(${translatedSub})</span>`;
          }
          return line;
        }).join('<br/>');
      } else {
        formattedRelated = formattedRelated.replace(/\n/g, '<br/>');
      }

      document.getElementById('backRelated').innerHTML = formattedRelated;
    } else {
      relContainer.classList.add('hidden');
    }

    // ★ 音声自動再生: 表面が表示された瞬間に単語を自動再生
    if (isAutoAudioEnabled && card) {
      if (autoAudioTimer) clearTimeout(autoAudioTimer);
      autoAudioTimer = setTimeout(() => {
        // カードが表面のままであれば再生
        if (!isCardFlipped) {
          speakJapanese(card);
        }
      }, 200);
    }
  }

  function flipCard() {
    const cardEl = document.getElementById('flashcardElement');
    if (!cardEl) return;
    isCardFlipped = !isCardFlipped;
    if (isCardFlipped) {
      cardEl.classList.add('rotate-y-180');
      // ★ 音声自動再生: 裏面が表示された瞬間に単語と例文を連続自動再生
      if (isAutoAudioEnabled && activeDeck[currentIndex]) {
        const card = activeDeck[currentIndex];
        if (autoAudioTimer) clearTimeout(autoAudioTimer);
        autoAudioTimer = setTimeout(() => {
          if (isCardFlipped) {
            const exampleJa = (card.example && card.example.ja) ? card.example.ja : null;
            speakJapaneseSequence(card, exampleJa);
          }
        }, 150);
      }
    } else {
      cardEl.classList.remove('rotate-y-180');
      // 表面に戻ったときも自動再生
      if (isAutoAudioEnabled && activeDeck[currentIndex]) {
        const card = activeDeck[currentIndex];
        if (autoAudioTimer) clearTimeout(autoAudioTimer);
        autoAudioTimer = setTimeout(() => {
          if (!isCardFlipped) {
            speakJapanese(card);
          }
        }, 150);
      }
    }
  }

  // --- Quiz Mode Logic ---
  let quizScope = 'current'; // 'current', 'folder', 'mylist', 'all'
  let quizScopeDetails = { type: 'current', id: null, title: '現在の単元' };

  function startQuizWithScope(type, id = null, title = '') {
    quizScope = type;
    quizScopeDetails = { type, id, title: title || '選択中スコープ' };
    switchView('quiz');
    startQuiz();
  }

  function startQuiz() {
    let sourcePool = [];

    if (quizScope === 'all') {
      sourcePool = [...vocabList];
    } else if (quizScope === 'mylist') {
      let starredCards = getMylistCards();
      if (activeMylistFolderId && activeMylistFolderId !== 'all') {
        starredCards = starredCards.filter(c => mylistCardFolderMap[c.id] === activeMylistFolderId);
      }
      sourcePool = starredCards;
    } else if (quizScope === 'folder') {
      const folderId = quizScopeDetails.id || currentFolder;
      sourcePool = vocabList.filter(c => c.folder_id === folderId);
    } else {
      // 'current' unit or whatever activeDeck is
      sourcePool = (activeDeck && activeDeck.length >= 2) ? [...activeDeck] : [...vocabList];
    }

    // Update UI badge
    const summaryBadge = document.getElementById('quizScopeSummaryBadge');
    if (summaryBadge) {
      if (quizScope === 'all') {
        summaryBadge.textContent = 'Shuffle All Units';
      } else if (quizScope === 'mylist') {
        const folderObj = mylistFolders.find(f => f.id === activeMylistFolderId);
        summaryBadge.textContent = folderObj ? `My List: 📁${folderObj.name}` : 'My List (All)';
      } else if (quizScope === 'folder') {
        const fc = FOLDER_CONFIGS.find(f => f.id === (quizScopeDetails.id || currentFolder));
        summaryBadge.textContent = fc ? `📁 ${fc.title}` : 'Entire Folder';
      } else {
        summaryBadge.textContent = quizScopeDetails.title || 'Current Unit';
      }
    }

    // Highlight active scope button if matches
    const btnCur = document.getElementById('btnQuizScopeCurrent');
    const btnMy = document.getElementById('btnQuizScopeMylist');
    const btnAll = document.getElementById('btnQuizScopeAll');
    if (btnCur && btnMy && btnAll) {
      const inactiveClass = 'py-1 px-1.5 rounded-xl text-[10px] font-bold border border-softBorder bg-white text-slate-600 hover:border-deepNavy transition text-center truncate';
      const activeClass = 'py-1 px-1.5 rounded-xl text-[10px] font-bold bg-deepNavy text-white transition shadow-2xs text-center truncate';
      btnCur.className = (quizScope === 'current' || quizScope === 'folder') ? activeClass : inactiveClass;
      btnMy.className = (quizScope === 'mylist') ? activeClass : inactiveClass;
      btnAll.className = (quizScope === 'all') ? activeClass : inactiveClass;
    }

    if (sourcePool.length < 2) {
      const container = document.getElementById('quizChoicesContainer');
      if (container) {
        container.innerHTML = `
          <div class="text-center py-10 text-slate-400 text-xs">
            <i data-lucide="alert-circle" class="w-8 h-8 mx-auto text-amber-500 mb-2"></i>
            <p class="font-bold text-slate-600 text-sm">Not enough words to test</p>
            <p class="mt-1">At least 2 words are required to start a test.</p>
          </div>
        `;
        lucide.createIcons({ root: container });
      }
      document.getElementById('quizQuestionText').textContent = '—';
      document.getElementById('quizQuestionHint').textContent = '';
      return;
    }

    // Shuffle cards for quiz pool
    quizPool = sourcePool.sort(() => Math.random() - 0.5);
    quizIndex = 0;
    quizScore = 0;
    renderQuizQuestion();
  }

  function renderQuizQuestion() {
    if (quizIndex >= quizPool.length || quizIndex >= 10) {
      showQuizFinished();
      return;
    }

    quizCurrentQuestion = quizPool[quizIndex];
    document.getElementById('quizScoreBadge').textContent = `Question ${quizIndex + 1} / ${Math.min(quizPool.length, 10)}`;
    
    // Meaning in current language (必ず母国語 & 英語)
    const meaning = getBilingualMeaning(quizCurrentQuestion.meaning, currentLang);
    document.getElementById('quizQuestionText').textContent = meaning;
    document.getElementById('quizQuestionHint').textContent = quizCurrentQuestion.category || 'General';

    // Distractor candidates pool
    const distractorCandidates = (quizScope === 'all' ? vocabList : activeDeck)
      .filter(c => c.id !== quizCurrentQuestion.id)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);
    
    const choices = [quizCurrentQuestion, ...distractorCandidates].sort(() => Math.random() - 0.5);

    const container = document.getElementById('quizChoicesContainer');
    container.innerHTML = '';

    const feedbackBox = document.getElementById('quizFeedbackBox');
    feedbackBox.classList.add('hidden');
    document.getElementById('btnQuizNext').disabled = true;

    choices.forEach(card => {
      const btn = document.createElement('button');
      btn.className = 'w-full py-3 px-4 rounded-xl border border-softBorder hover:border-deepNavy bg-white font-bold text-darkNavyText text-left transition flex items-center justify-between shadow-2xs text-sm';
      btn.innerHTML = `
        <span>${card.word} <span class="text-xs text-slate-400 font-normal">（${card.reading || ''}）</span></span>
        <i data-lucide="chevron-right" class="w-4 h-4 text-slate-300"></i>
      `;
      lucide.createIcons({ root: btn });

      btn.addEventListener('click', () => {
        handleQuizAnswer(card, btn, container);
      });
      container.appendChild(btn);
    });
  }

  function handleQuizAnswer(selectedCard, clickedBtn, container) {
    const allButtons = container.querySelectorAll('button');
    allButtons.forEach(b => b.disabled = true);

    const feedbackBox = document.getElementById('quizFeedbackBox');
    const feedbackMsg = document.getElementById('quizFeedbackMessage');
    const feedbackDetail = document.getElementById('quizFeedbackDetail');
    feedbackBox.classList.remove('hidden');

    const isCorrect = selectedCard.id === quizCurrentQuestion.id;
    if (isCorrect) {
      quizScore++;
      clickedBtn.classList.remove('border-softBorder');
      clickedBtn.classList.add('border-emerald-500', 'bg-emerald-50', 'text-emerald-900');
      feedbackBox.className = 'p-3 rounded-2xl my-2 text-center bg-emerald-50 border border-emerald-200 text-emerald-800';
      feedbackMsg.textContent = 'Correct! ✨';
      feedbackDetail.textContent = `${quizCurrentQuestion.word}（${quizCurrentQuestion.reading || ''}）`;
      speakJapanese(quizCurrentQuestion);
    } else {
      clickedBtn.classList.remove('border-softBorder');
      clickedBtn.classList.add('border-coralPink', 'bg-rose-50', 'text-rose-900');
      feedbackBox.className = 'p-3 rounded-2xl my-2 text-center bg-rose-50 border border-rose-200 text-rose-800';
      feedbackMsg.textContent = 'Not quite! The correct answer is:';
      feedbackDetail.textContent = `${quizCurrentQuestion.word}（${quizCurrentQuestion.reading || ''}）`;
      mylistSet.add(quizCurrentQuestion.id);
      saveMylistForCurrentStudent();
      showToast('Added missed word to My List ⭐');
    }

    document.getElementById('btnQuizNext').disabled = false;
  }

  function showQuizFinished() {
    const container = document.getElementById('quizChoicesContainer');
    container.innerHTML = `
      <div class="text-center py-6">
        <div class="text-4xl mb-2">🏆</div>
        <h4 class="text-xl font-bold text-slate-900">Quiz Completed!</h4>
        <p class="text-sm text-slate-600 mt-1">Score: <span class="text-rose-600 font-extrabold text-lg">${quizScore}</span> / ${Math.min(quizPool.length, 10)} Correct</p>
        <button id="btnRestartQuiz" class="mt-5 px-6 py-2.5 rounded-2xl bg-rose-600 text-white font-bold text-xs shadow-md">Try Again</button>
      </div>
    `;
    document.getElementById('quizQuestionText').textContent = 'Well done! Great job! 🎉';
    document.getElementById('quizQuestionHint').textContent = '';
    document.getElementById('quizFeedbackBox').classList.add('hidden');
    document.getElementById('btnQuizNext').classList.add('hidden');

    document.getElementById('btnRestartQuiz').addEventListener('click', () => {
      document.getElementById('btnQuizNext').classList.remove('hidden');
      startQuiz();
    });
  }

  // --- Card Resolution Helper for My List & Study ---
  // Resolves a card by ID or word across vocabList, CLASS_VOCAB_DATA, INITIAL_VOCAB_DATA, and DICT_DATA
  function getCardById(cardId) {
    if (!cardId) return null;
    // 1. Check current in-memory vocabList
    let found = vocabList.find(c => c.id === cardId || c.word === cardId);
    if (found) return found;

    // 1b. Check haku_all_custom_cards from localStorage
    try {
      const storedCustom = JSON.parse(localStorage.getItem('haku_all_custom_cards') || '[]');
      if (Array.isArray(storedCustom)) {
        found = storedCustom.find(c => c.id === cardId || c.word === cardId);
        if (found) {
          found.isCustom = true;
          vocabList.push(found);
          return found;
        }
      }
    } catch (e) {}

    // 2. Check CLASS_VOCAB_DATA
    if (window.CLASS_VOCAB_DATA) {
      found = window.CLASS_VOCAB_DATA.find(c => c.id === cardId || c.word === cardId);
      if (found) return found;
    }

    // 3. Check INITIAL_VOCAB_DATA
    if (window.INITIAL_VOCAB_DATA) {
      found = window.INITIAL_VOCAB_DATA.find(c => c.id === cardId || c.word === cardId);
      if (found) return found;
    }

    // 4. Check DICT_DATA
    if (window.DICT_DATA) {
      let wordToFind = cardId;
      if (cardId.startsWith('dict_')) {
        const parts = cardId.split('_');
        if (parts.length >= 3) {
          wordToFind = parts.slice(1, parts.length - 1).join('_');
        }
      }
      const entry = window.DICT_DATA.find(d => d.w === wordToFind || d.w === cardId);
      if (entry) {
        const exMap = window.DICT_EXAMPLES_MAP || {};
        const matchedEx = exMap[entry.w] || (entry.r ? exMap[entry.r] : null);
        return {
          id: cardId,
          word: entry.w,
          reading: entry.r || entry.w,
          category: entry.l ? `JLPT ${entry.l}` : '辞書',
          section_title: '日本語大辞書',
          meaning: {
            en: (entry.m && entry.m.join(', ')) || '—',
            ja: entry.w,
            zh_TW: (entry.zh && entry.zh.join(', ')) || (entry.m && entry.m.join(', ')) || '—',
            zh_CN: (entry.zh && entry.zh.join(', ')) || (entry.m && entry.m.join(', ')) || '—',
            ko: (entry.m && entry.m.join(', ')) || '—',
            zh_HK: (entry.zh && entry.zh.join(', ')) || (entry.m && entry.m.join(', ')) || '—',
            fr: (entry.fr && entry.fr.join(', ')) || (entry.m && entry.m.join(', ')) || '—'
          },
          example: {
            ja: matchedEx ? matchedEx.ja : `A: <ruby>${entry.w}<rt>${entry.r || entry.w}</rt></ruby>について<ruby>話<rt>はな</rt></ruby>しましょう。<br/>B: はい、わかりました！`,
            en: matchedEx ? (matchedEx.en || '') : `A: Let's talk about "${entry.w}".<br/>B: Yes, understood!`
          },
          related: `【品詞】${entry.p || '一般'} / 【JLPT】${entry.l || '一般'}`,
          isDict: true
        };
      }
    }

    // 5. Fallback stub so word card always renders instead of being hidden
    return {
      id: cardId,
      word: cardId.replace(/^card_\d+_/, '').replace(/^dict_/, '').replace(/_\d+$/, '') || cardId,
      reading: '',
      category: 'マイリスト',
      meaning: { en: 'Saved Word', ja: cardId, zh_TW: '單詞', zh_CN: '单词', ko: '단어', zh_HK: '單詞', fr: 'Mot' },
      example: { ja: '', en: '' }
    };
  }

  // Returns all resolved card objects currently in My List
  function getMylistCards() {
    const cards = [];
    mylistSet.forEach(id => {
      const card = getCardById(id);
      if (card) cards.push(card);
    });
    return cards;
  }

  // --- Mylist View Rendering with Custom Folders ---
  function renderMylistView() {
    renderMylistFolderTabs();
    renderMylistItems();
  }

  function renderMylistFolderTabs() {
    const tabsContainer = document.getElementById('mylistFolderTabs');
    if (!tabsContainer) return;
    tabsContainer.innerHTML = '';

    const allCards = getMylistCards();

    // 'All' tab
    const allStarredCount = allCards.length;
    const allTab = document.createElement('button');
    const isAllActive = activeMylistFolderId === 'all';
    allTab.className = `px-3 py-1 rounded-full text-xs font-bold transition flex items-center space-x-1 shrink-0 ${
      isAllActive
        ? 'bg-deepNavy text-white shadow-xs'
        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
    }`;
    allTab.innerHTML = `<span>All</span><span class="text-[10px] opacity-80">(${allStarredCount})</span>`;
    allTab.addEventListener('click', () => {
      activeMylistFolderId = 'all';
      renderMylistView();
    });
    tabsContainer.appendChild(allTab);

    // Custom folders tabs
    mylistFolders.forEach(folder => {
      const folderCardsCount = allCards.filter(c => mylistCardFolderMap[c.id] === folder.id).length;
      const tab = document.createElement('button');
      const isActive = activeMylistFolderId === folder.id;
      tab.className = `px-3 py-1 rounded-full text-xs font-bold transition flex items-center space-x-1 shrink-0 ${
        isActive
          ? 'bg-coralPink text-white shadow-xs'
          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
      }`;
      tab.innerHTML = `<span>📁 ${folder.name}</span><span class="text-[10px] opacity-80">(${folderCardsCount})</span>`;
      tab.addEventListener('click', () => {
        activeMylistFolderId = folder.id;
        renderMylistView();
      });
      tabsContainer.appendChild(tab);
    });

    // Action bar for current selected folder
    const actionBar = document.getElementById('mylistFolderActionBar');
    const folderNameElem = document.getElementById('currentMylistFolderName');
    if (actionBar && folderNameElem) {
      if (activeMylistFolderId === 'all') {
        actionBar.classList.add('hidden');
      } else {
        const currentFolderObj = mylistFolders.find(f => f.id === activeMylistFolderId);
        if (currentFolderObj) {
          actionBar.classList.remove('hidden');
          folderNameElem.textContent = `📁 Folder: ${currentFolderObj.name}`;
        } else {
          actionBar.classList.add('hidden');
        }
      }
    }
  }

  function renderMylistItems() {
    const container = document.getElementById('mylistItemsContainer');
    if (!container) return;
    container.innerHTML = '';

    let displayedCards = getMylistCards();
    if (activeMylistFolderId !== 'all') {
      displayedCards = displayedCards.filter(c => mylistCardFolderMap[c.id] === activeMylistFolderId);
    }

    if (displayedCards.length === 0) {
      container.innerHTML = `
        <div class="text-center py-12 text-slate-400 text-xs">
          <p>${activeMylistFolderId === 'all' ? 'No words saved to My List yet.' : 'No words in this folder yet.'}</p>
          <p class="mt-1">Tap the "⭐" icon on cards or use the folder dropdown to add words.</p>
        </div>
      `;
      return;
    }

    displayedCards.forEach(card => {
      const item = document.createElement('div');
      item.className = 'p-3 rounded-2xl border border-slate-200 bg-slate-50 flex items-center justify-between transition hover:shadow-2xs';
      const meaning = getBilingualMeaning(card.meaning, currentLang);
      const currentFolderId = mylistCardFolderMap[card.id] || '';

      // Build folder selector options
      let folderOptionsHtml = `<option value="" ${!currentFolderId ? 'selected' : ''}>Unfiled</option>`;
      mylistFolders.forEach(f => {
        folderOptionsHtml += `<option value="${f.id}" ${currentFolderId === f.id ? 'selected' : ''}>📁 ${f.name}</option>`;
      });

      item.innerHTML = `
        <div class="flex-1 pr-2 cursor-pointer btn-open-card-study">
          <div class="flex items-center space-x-1.5">
            <span class="font-bold text-slate-900 text-sm hover:text-deepNavy transition">${card.word}</span>
            <span class="card-reading-text text-xs text-slate-400">（${card.reading || ''}）</span>
          </div>
          <p class="text-xs text-rose-600 font-medium mt-0.5">${meaning}</p>
          <div class="mt-1 flex items-center space-x-1" onclick="event.stopPropagation()">
            <label class="text-[10px] text-slate-400 font-medium">Folder:</label>
            <select class="folder-assign-select text-[10px] py-0.5 px-1.5 rounded-lg border border-slate-200 bg-white text-slate-600 focus:outline-none focus:ring-1 focus:ring-deepNavy">
              ${folderOptionsHtml}
            </select>
          </div>
        </div>
        <div class="flex items-center space-x-1 shrink-0">
          <button class="btn-study-single p-2 text-deepNavy hover:text-coralPink transition rounded-full hover:bg-white" title="${currentLang === 'ja' ? '練習カードで学習' : (currentLang === 'zh_TW' || currentLang === 'zh_HK' ? '練習卡片' : (currentLang === 'zh_CN' ? '练习卡片' : (currentLang === 'ko' ? '연습 카드' : (currentLang === 'fr' ? 'Cartes de pratique' : 'Practice Card'))))}">
            <i data-lucide="play" class="w-4 h-4 fill-deepNavy"></i>
          </button>
          <button class="btn-voice p-2 text-slate-500 hover:text-coralPink transition rounded-full hover:bg-white" title="Listen">
            <i data-lucide="volume-2" class="w-4 h-4"></i>
          </button>
          <button class="btn-remove-star p-2 text-amber-500 hover:text-slate-400 transition rounded-full hover:bg-white" title="Remove from My List">
            <i data-lucide="star" class="w-4 h-4 fill-amber-400"></i>
          </button>
        </div>
      `;
      lucide.createIcons({ root: item });

      // Click on word or play button opens in interactive 3D flashcard study mode
      const studySingleHandler = (e) => {
        e.stopPropagation();
        activeDeck = [card];
        currentIndex = 0;
        isSearchStudyMode = true;
        switchView('flashcards');
        document.getElementById('folderOverviewPanel').classList.add('hidden');
        document.getElementById('unitListPanel').classList.add('hidden');
        document.getElementById('activeStudyHeader').classList.remove('hidden');
        document.getElementById('activeStudySectionName').textContent = card.word;
        document.getElementById('activeStudyFolderName').textContent = currentLang === 'ja' ? 'マイリスト' : 'My List';
        renderCurrentCard();
      };

      const wordTitle = item.querySelector('.btn-open-card-study');
      if (wordTitle) wordTitle.addEventListener('click', studySingleHandler);
      const btnStudySingle = item.querySelector('.btn-study-single');
      if (btnStudySingle) btnStudySingle.addEventListener('click', studySingleHandler);

      // Voice
      item.querySelector('.btn-voice').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleJapaneseSpeech(card);
      });

      // Remove from star
      item.querySelector('.btn-remove-star').addEventListener('click', () => {
        mylistSet.delete(card.id);
        delete mylistCardFolderMap[card.id];
        saveMylistForCurrentStudent();
        renderMylistView();
        renderCurrentCard();
      });

      // Folder change dropdown
      const selectElem = item.querySelector('.folder-assign-select');
      selectElem.addEventListener('change', (e) => {
        const newFolderId = e.target.value;
        if (newFolderId) {
          mylistCardFolderMap[card.id] = newFolderId;
        } else {
          delete mylistCardFolderMap[card.id];
        }
        saveMylistForCurrentStudent();
        renderMylistView();
        showToast('Moved to folder 📁');
      });

      container.appendChild(item);
    });
  }

  // --- Admin Student Management Rendering ---
  function renderAdminStudentList() {
    const container = document.getElementById('adminStudentList');
    const targetSelect = document.getElementById('adminTargetStudent');

    // Populate Target Student dropdown for adding cards
    if (targetSelect) {
      const currentSelected = targetSelect.value || 'all';
      let optionsHtml = `<option value="all">全員共有デッキ (All Students)</option>`;
      students.filter(s => s.id !== 'haku' && s.id !== 'admin').forEach(st => {
        optionsHtml += `<option value="${st.id}">[${st.id}] ${st.name} (${st.lang})</option>`;
      });
      targetSelect.innerHTML = optionsHtml;
      targetSelect.value = currentSelected;
    }

    if (!container) return;
    container.innerHTML = '';

    students.forEach(st => {
      // Don't show admin entries in normal student list or mark specially
      const isTeacher = (st.id === 'haku' || st.id === 'admin');
      const isCurrentLoggedIn = currentStudent && currentStudent.id === st.id;
      const row = document.createElement('div');
      row.className = `flex items-center justify-between p-2 rounded-xl bg-white border transition ${
        isCurrentLoggedIn ? 'border-coralPink bg-rose-50/30 ring-1 ring-coralPink/30' : 'border-slate-200 hover:border-slate-300'
      } shadow-2xs text-xs`;
      row.innerHTML = `
        <div class="btn-select-student flex items-center space-x-1.5 truncate cursor-pointer hover:opacity-80 py-0.5" title="クリックしてこの生徒としてログイン">
          <span class="font-mono text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">${st.id}</span>
          <span class="font-bold text-slate-800 truncate">${st.name}</span>
          <span class="text-[9px] px-1.5 py-0.2 rounded font-semibold bg-lightBlueBg text-deepNavy">${st.lang}</span>
          ${isCurrentLoggedIn ? '<span class="text-[9px] px-1 py-0.2 rounded font-bold bg-coralPink text-white">ログイン中</span>' : ''}
        </div>
        <div class="flex items-center space-x-1.5 shrink-0">
          <span class="font-mono text-xs text-rose-600 font-bold bg-rose-50 px-2 py-0.5 rounded-lg border border-rose-100">
            PIN: ${st.passcode}
          </span>
          ${!isTeacher ? `
            <button class="btn-login-as-student px-2 py-0.5 rounded-lg ${isCurrentLoggedIn ? 'bg-coralPink text-white' : 'bg-slate-100 hover:bg-deepNavy hover:text-white text-slate-700'} font-bold text-[10px] transition flex items-center space-x-1" title="この生徒としてログイン">
              <i data-lucide="log-in" class="w-3 h-3"></i>
              <span>${isCurrentLoggedIn ? '利用中' : 'ログイン'}</span>
            </button>
            <button class="btn-edit-student p-1 text-slate-400 hover:text-sky-600 transition" title="生徒情報を編集">
              <i data-lucide="edit-3" class="w-3.5 h-3.5"></i>
            </button>
            <button class="btn-delete-student p-1 text-slate-300 hover:text-rose-500 transition" title="生徒を削除">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          ` : '<span class="text-[10px] text-slate-400 font-bold px-1">先生</span>'}
        </div>
      `;
      lucide.createIcons({ root: row });

      if (!isTeacher) {
        const handleLoginAs = () => {
          setStudent(st);
          renderAdminStudentList();
          switchView('mylist');
          showToast(`生徒「${st.name}」としてログインしました！🎓`);
        };

        const selectStudentBtn = row.querySelector('.btn-select-student');
        if (selectStudentBtn) {
          selectStudentBtn.addEventListener('click', handleLoginAs);
        }

        const loginBtn = row.querySelector('.btn-login-as-student');
        if (loginBtn) {
          loginBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            handleLoginAs();
          });
        }

        const editBtn = row.querySelector('.btn-edit-student');
        if (editBtn) {
          editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openEditStudentModal(st);
          });
        }

        const delBtn = row.querySelector('.btn-delete-student');
        if (delBtn) {
          delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!confirm(`生徒「${st.name}」（ID: ${st.id}）を削除しますか？`)) return;
            students = students.filter(s => s.id !== st.id);
            localStorage.setItem('haku_students', JSON.stringify(students));
            renderAdminStudentList();
            showToast(`生徒「${st.name}」を削除しました`);
          });
        }
      }

      container.appendChild(row);
    });
  }

  // --- Batch Import Logic for Haku-sensei ---
  function executeImport() {
    const rawText = document.getElementById('adminImportText').value.trim();
    const target = document.getElementById('adminTargetStudent').value;
    const targetFolderSelect = document.getElementById('adminImportFolderSelect')?.value || 'folder_class_words';
    if (!rawText) {
      showToast('インポートするテキストを入力してください');
      return;
    }

    // Smart splitting: support both newline-separated and single-line comma/space-separated entries
    let rawItems = [];
    if (rawText.includes('\n')) {
      rawItems = rawText.split('\n');
    } else {
      // Single continuous line like: 観光地（かんこうち）,tourist destination 飲食店（いんしょくてん）,restaurant
      // Match Japanese word (with optional furigana) and comma/tab followed by meaning
      const regexPattern = /([^\s,，\t]+(?:（[^）]+）|\([^)]+\))?)\s*[,，\t]\s*([^,，\t\n]+?)(?=(?:\s+[^\s,，\t]+(?:（[^）]+）|\([^)]+\))?\s*[,，\t])|$)/g;
      let match;
      while ((match = regexPattern.exec(rawText)) !== null) {
        if (match[1] && match[2]) {
          rawItems.push(`${match[1].trim()}\t${match[2].trim()}`);
        }
      }
      if (rawItems.length === 0) {
        rawItems = [rawText];
      }
    }

    let addedCount = 0;
    const addedCardIds = [];

    const importLangOption = document.getElementById('adminImportLangSelect')?.value || 'auto';
    const targetStudentObj = students.find(s => s.id === target);
    const targetStudentLang = targetStudentObj ? targetStudentObj.lang : 'en';

    rawItems.forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#') || /^[①-⑩\d]+$/.test(line)) return;

      // Split by tab, comma, or slash
      let parts = line.split('\t');
      if (parts.length === 1) parts = line.split(',');
      if (parts.length === 1) parts = line.split('／');

      if (parts.length >= 1) {
        const rawWord = parts[0].trim();
        if (!rawWord) return;

        // Extract word and reading if formatted like: 机 (つくえ) or 食べる（たべる）
        let word = rawWord;
        let reading = '';
        const match = rawWord.match(/^(.*?)[（\(](.*?)[）\)]/);
        if (match) {
          word = match[1].trim();
          reading = match[2].trim();
        }

        let rawTrans = '';
        let parsedNative = '';
        let parsedEn = '';
        let exJa = '';
        let related = '';

        if (parts.length >= 4) {
          // Format 4-column: 日本語 \t 生徒の母国語 \t 英語 \t 例文
          parsedNative = parts[1].trim();
          parsedEn = parts[2].trim();
          exJa = parts[3].trim();
          rawTrans = parsedNative;
          if (parts[4]) related = parts[4].trim();
        } else if (parts.length === 3) {
          // Could be: 日本語 \t 意味(母国語/英語) \t 例文
          rawTrans = parts[1].trim();
          exJa = parts[2].trim();
          parsedNative = rawTrans;
          parsedEn = rawTrans;
        } else {
          // 2 columns or 1 column
          rawTrans = parts[1] ? parts[1].trim() : '';
          parsedNative = rawTrans;
          parsedEn = rawTrans;
        }

        // Smart parser for bilingual meaning if still packed (e.g., "吃 (to eat)" or "去 / to go")
        if (!parsedEn || parsedEn === parsedNative) {
          const parenMatch = rawTrans.match(/^(.*?)[（\(\[](.*?)[）\)\]]$/);
          if (parenMatch) {
            const p1 = parenMatch[1].trim();
            const p2 = parenMatch[2].trim();
            if (/[a-zA-Z]/.test(p2)) {
              parsedNative = p1 || p2;
              parsedEn = p2;
            } else if (/[a-zA-Z]/.test(p1)) {
              parsedNative = p2;
              parsedEn = p1;
            }
          } else if (rawTrans.includes('/')) {
            const slashParts = rawTrans.split('/').map(s => s.trim());
            const enPart = slashParts.find(s => /^[a-zA-Z\s,.'"-]+$/.test(s));
            const nativePart = slashParts.find(s => !/^[a-zA-Z\s,.'"-]+$/.test(s));
            if (enPart && nativePart) {
              parsedEn = enPart;
              parsedNative = nativePart;
            }
          }
        }

        // Determine specific language to assign
        const activeLangKey = (importLangOption !== 'auto') ? importLangOption : (targetStudentLang !== 'en' ? targetStudentLang : 'zh_CN');

        const meaningObj = {
          en: parsedEn || rawTrans || 'Meaning',
          ja: parsedNative || word,
          zh_TW: parsedNative || rawTrans || '意思',
          zh_CN: parsedNative || rawTrans || '意思',
          ko: parsedNative || rawTrans || '뜻',
          zh_HK: parsedNative || rawTrans || '意思',
          fr: parsedEn || rawTrans || 'Sens'
        };

        // If target student or import lang is specific, tailor that slot
        if (activeLangKey && activeLangKey !== 'en') {
          meaningObj[activeLangKey] = parsedNative || rawTrans;
        }

        // Find dictionary example if exJa is not explicitly provided
        let resolvedJa = exJa;
        let resolvedEn = exJa;
        let resolvedZhTW = exJa;
        let resolvedZhCN = exJa;
        let resolvedKo = exJa;
        let resolvedZhHK = exJa;
        let resolvedFr = exJa;

        if (!resolvedJa) {
          const dictMap = window.DICT_EXAMPLES_MAP || {};
          const matchedEx = dictMap[word] || (reading ? dictMap[reading] : null);
          if (matchedEx && matchedEx.ja) {
            resolvedJa = matchedEx.ja;
            resolvedEn = matchedEx.en || matchedEx.ja;
            resolvedZhTW = matchedEx.zh_TW || matchedEx.en || matchedEx.ja;
            resolvedZhCN = matchedEx.zh_CN || matchedEx.en || matchedEx.ja;
            resolvedKo = matchedEx.ko || matchedEx.en || matchedEx.ja;
            resolvedZhHK = matchedEx.zh_HK || matchedEx.en || matchedEx.ja;
            resolvedFr = matchedEx.fr || matchedEx.en || matchedEx.ja;
          } else {
            // Natural conversational placeholder instead of robotic boilerplate
            resolvedJa = `A: <ruby>${word}<rt>${reading || word}</rt></ruby>について<ruby>話<rt>はな</rt></ruby>しましょう。<br/>B: はい、わかりました！`;
            resolvedEn = `A: Let's talk about "${word}".<br/>B: Yes, understood!`;
            resolvedZhTW = `A: 我們來聊聊關於「${word}」的話題吧。<br/>B: 好的，明白了！`;
            resolvedZhCN = `A: 我们来聊聊关于「${word}」的话题吧。<br/>B: 好的，明白了！`;
            resolvedKo = `A: "${word}"에 대해 이야기해 봅시다.<br/>B: 네, 알겠습니다!`;
            resolvedZhHK = `A: 我哋嚟傾下關於「${word}」嘅話題啦。<br/>B: 好呀，明白！`;
            resolvedFr = `A: Parlons de « ${word} ».<br/>B: Oui, d'accord !`;
          }
        }

        const cardId = `card_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const newCard = {
          id: cardId,
          word: word,
          reading: reading || word,
          category: '授業で習った言葉',
          studentId: target === 'all' ? null : target,
          meaning: meaningObj,
          example: {
            ja: resolvedJa,
            en: resolvedEn || resolvedJa,
            zh_TW: resolvedZhTW || resolvedJa,
            zh_CN: resolvedZhCN || resolvedJa,
            ko: resolvedKo || resolvedJa,
            zh_HK: resolvedZhHK || resolvedJa,
            fr: resolvedFr || resolvedJa
          },
          related: related || (reading ? `${reading}` : '重要表現')
        };

        vocabList.push(newCard);
        addedCardIds.push(cardId);
        addedCount++;
      }
    });

    if (addedCount > 0) {
      localStorage.setItem('haku_vocab_data', JSON.stringify(vocabList));

      // Auto-add to My List and assign to requested folder!
      if (targetFolderSelect !== 'none') {
        const destFolderId = (targetFolderSelect === 'folder_class_words') ? 'folder_class_words' : '';
        const destFolderName = '授業で習った言葉';

        // Targets: if 'all', all students + guest; else the specific student
        const recipientStudentIds = (target === 'all') 
          ? [...students.map(s => s.id), 'guest'] 
          : [target];

        recipientStudentIds.forEach(stId => {
          const key = `haku_mylist_${stId}`;
          const foldersKey = `haku_mylist_folders_${stId}`;
          const mapKey = `haku_mylist_card_map_${stId}`;

          // Folders
          let stFolders = [];
          try { stFolders = JSON.parse(localStorage.getItem(foldersKey) || '[]'); } catch (e) { stFolders = []; }
          if (destFolderId === 'folder_class_words') {
            if (!stFolders.find(f => f.id === 'folder_class_words')) {
              stFolders.unshift({ id: 'folder_class_words', name: destFolderName });
              localStorage.setItem(foldersKey, JSON.stringify(stFolders));
            }
          }

          // Card folder map
          let stMap = {};
          try { stMap = JSON.parse(localStorage.getItem(mapKey) || '{}'); } catch (e) { stMap = {}; }
          if (destFolderId) {
            addedCardIds.forEach(id => { stMap[id] = destFolderId; });
            localStorage.setItem(mapKey, JSON.stringify(stMap));
          }

          // Mylist items
          let stSet = [];
          try { stSet = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { stSet = []; }
          const setObj = new Set([...stSet, ...addedCardIds]);
          localStorage.setItem(key, JSON.stringify(Array.from(setObj)));

          // Synchronize to Cloud for this student so their devices receive the new words AND the card definitions
          if (isFirebaseReady && fbDb && stId !== 'guest') {
            const mylistCardIds = new Set(setObj);
            const studentCustomCards = vocabList.filter(c => mylistCardIds.has(c.id) && c.id.startsWith('card_'));
            fbDb.collection('students').doc(stId).set({
              mylist: Array.from(setObj),
              folders: stFolders,
              cardFolderMap: stMap,
              customCards: studentCustomCards,
              updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true }).catch(e => console.warn('Cloud broadcast note:', e.message));
          }
        });

        // If the current logged in student is one of the recipients, reload their mylist state immediately
        const currentId = currentStudent ? currentStudent.id : 'guest';
        if (recipientStudentIds.includes(currentId)) {
          loadMylistForCurrentStudent();
        }
      }

      showToast(`${addedCount}件の単語を追加し、マイリストに反映しました！⭐`);
      document.getElementById('adminImportText').value = '';
      populateCategoryTabs();
      updateActiveDeck();
      // Switch to mylist view so teacher immediately sees the result
      switchView('mylist');
    } else {
      showToast('フォーマットを認識できませんでした');
    }
  }

  // --- View Switching Navigation ---
  function switchView(viewName) {
    document.getElementById('viewFlashcards').classList.add('hidden');
    document.getElementById('viewQuiz').classList.add('hidden');
    document.getElementById('viewMylist').classList.add('hidden');
    document.getElementById('viewAdmin').classList.add('hidden');

    const navStudy = document.getElementById('navStudy');
    const navQuiz = document.getElementById('navQuiz');
    const navMylist = document.getElementById('navMylist');

    const inactiveClass = 'flex-1 py-1 px-3 rounded-full border border-softBorder hover:border-deepNavy bg-white text-slate-700 flex items-center justify-center space-x-1 transition';
    const activeClass = 'flex-1 py-1 px-3 rounded-full text-white bg-deepNavy flex items-center justify-center space-x-1 transition shadow-xs';

    if (navStudy) navStudy.className = (viewName === 'flashcards') ? activeClass : inactiveClass;
    if (navQuiz) navQuiz.className = (viewName === 'quiz') ? activeClass : inactiveClass;
    if (navMylist) navMylist.className = (viewName === 'mylist') ? activeClass : inactiveClass;

    if (viewName === 'flashcards') {
      document.getElementById('viewFlashcards').classList.remove('hidden');
    } else if (viewName === 'quiz') {
      document.getElementById('viewQuiz').classList.remove('hidden');
      startQuiz();
    } else if (viewName === 'mylist') {
      document.getElementById('viewMylist').classList.remove('hidden');
      renderMylistView();
      // Instantly pull any new data from cloud when opening My List
      if (currentStudent && currentStudent.id !== 'guest') {
        syncStudentFromCloud(currentStudent.id).then(changed => {
          if (changed) {
            renderMylistView();
          }
        });
      }
    } else if (viewName === 'admin') {
      document.getElementById('viewAdmin').classList.remove('hidden');
    }
  }

  // --- Setup Event Listeners ---
  function setupListeners() {
    let hasMovedBeyondTapThreshold = false;

    // Navigation tabs
    document.getElementById('navStudy').addEventListener('click', () => {
      // Clear search query and close dropdown
      const topSearch = document.getElementById('globalTopSearchInput');
      const clearTopBtn = document.getElementById('btnClearTopSearch');
      const dropdown = document.getElementById('searchDropdownContainer');
      if (topSearch) topSearch.value = '';
      if (clearTopBtn) clearTopBtn.classList.add('hidden');
      if (dropdown) dropdown.classList.add('hidden');
      sidebarSearchQuery = '';

      // Return to folder overview
      backToFolderOverview();
      switchView('flashcards');
    });
    document.getElementById('navQuiz').addEventListener('click', () => switchView('quiz'));
    document.getElementById('navMylist').addEventListener('click', () => switchView('mylist'));
    // Discreet Teacher Admin Modal Trigger (生徒に見せない暗証番号保護)
    document.getElementById('navAdmin').addEventListener('click', () => {
      document.getElementById('adminAuthModal').classList.remove('hidden');
      document.getElementById('adminPassInput').value = '';
    });

    document.getElementById('btnAdminAuthCancel').addEventListener('click', () => {
      document.getElementById('adminAuthModal').classList.add('hidden');
    });

    document.getElementById('btnAdminAuthSubmit').addEventListener('click', () => {
      const pin = document.getElementById('adminPassInput').value.trim();
      // Allow user requested passcode 'ppooii0099' or legacy PINs
      if (pin === 'ppooii0099' || pin === '0000' || pin === '1234') {
        document.getElementById('adminAuthModal').classList.add('hidden');
        switchView('admin');
        showToast('ハク先生・管理者モードを開きました ✨');
      } else {
        showToast('パスワードが違います');
      }
    });

    // --- Furigana & Auto Audio Toggle Controls (Top Header) ---
    function updateFuriganaUi() {
      const btn = document.getElementById('btnToggleFurigana');
      if (document.body) {
        document.body.classList.toggle('furigana-off', !isFuriganaEnabled);
      }
      if (btn) {
        btn.setAttribute('aria-checked', isFuriganaEnabled ? 'true' : 'false');
        if (isFuriganaEnabled) {
          btn.classList.add('is-on');
          btn.classList.remove('is-off');
        } else {
          btn.classList.remove('is-on');
          btn.classList.add('is-off');
        }
      }
    }

    function updateAutoAudioUi() {
      const btn = document.getElementById('btnToggleAutoAudio');
      if (btn) {
        btn.setAttribute('aria-checked', isAutoAudioEnabled ? 'true' : 'false');
        if (isAutoAudioEnabled) {
          btn.classList.add('is-on');
          btn.classList.remove('is-off');
        } else {
          btn.classList.remove('is-on');
          btn.classList.add('is-off');
        }
      }
    }

    // Initial state setup on boot
    updateFuriganaUi();
    updateAutoAudioUi();

    function handleToggleFurigana() {
      isFuriganaEnabled = !isFuriganaEnabled;
      localStorage.setItem('haku_furigana_enabled', isFuriganaEnabled ? 'true' : 'false');
      updateFuriganaUi();
      showToast(isFuriganaEnabled ? 'ふりがなを表示します（ON）' : 'ふりがなを非表示にしました（OFF）');
    }

    const btnToggleFuri = document.getElementById('btnToggleFurigana');
    if (btnToggleFuri) {
      btnToggleFuri.addEventListener('click', handleToggleFurigana);
    }
    const containerToggleFuri = document.getElementById('containerToggleFurigana');
    if (containerToggleFuri) {
      containerToggleFuri.addEventListener('click', (e) => {
        if (!e.target.closest('#btnToggleFurigana')) {
          handleToggleFurigana();
        }
      });
    }

    function handleToggleAutoAudio() {
      isAutoAudioEnabled = !isAutoAudioEnabled;
      localStorage.setItem('haku_auto_audio_enabled', isAutoAudioEnabled ? 'true' : 'false');
      updateAutoAudioUi();
      showToast(isAutoAudioEnabled ? '音声自動再生を有効にしました（ON 🔊）' : '音声自動再生を解除しました（OFF 🔇）');
      if (isAutoAudioEnabled && activeDeck[currentIndex]) {
        const card = activeDeck[currentIndex];
        if (!isCardFlipped) {
          speakJapanese(card);
        } else {
          const exampleJa = (card.example && card.example.ja) ? card.example.ja : null;
          speakJapaneseSequence(card, exampleJa);
        }
      }
    }

    const btnToggleAudio = document.getElementById('btnToggleAutoAudio');
    if (btnToggleAudio) {
      btnToggleAudio.addEventListener('click', handleToggleAutoAudio);
    }
    const containerToggleAudio = document.getElementById('containerToggleAutoAudio');
    if (containerToggleAudio) {
      containerToggleAudio.addEventListener('click', (e) => {
        if (!e.target.closest('#btnToggleAutoAudio')) {
          handleToggleAutoAudio();
        }
      });
    }

    // Portal Drawer Open/Close controls (2枚目写真仕様)
    const btnOpenDrawer = document.getElementById('btnOpenMenuDrawer');
    if (btnOpenDrawer) {
      btnOpenDrawer.addEventListener('click', openMenuDrawer);
    }

    const btnCloseDrawer = document.getElementById('btnCloseMenuDrawer');
    if (btnCloseDrawer) {
      btnCloseDrawer.addEventListener('click', closeMenuDrawer);
    }

    const drawerOverlay = document.getElementById('portalDrawerOverlay');
    if (drawerOverlay) {
      drawerOverlay.addEventListener('click', closeMenuDrawer);
    }

    // Portal Drawer Menu Buttons
    const drawerBtnHome = document.getElementById('drawerBtnHome');
    if (drawerBtnHome) {
      drawerBtnHome.addEventListener('click', () => {
        closeMenuDrawer();
        const topSearch = document.getElementById('globalTopSearchInput');
        const clearTopBtn = document.getElementById('btnClearTopSearch');
        const dropdown = document.getElementById('searchDropdownContainer');
        if (topSearch) topSearch.value = '';
        if (clearTopBtn) clearTopBtn.classList.add('hidden');
        if (dropdown) dropdown.classList.add('hidden');
        sidebarSearchQuery = '';

        backToFolderOverview();
        switchView('flashcards');
      });
    }

    const drawerBtnMylist = document.getElementById('drawerBtnMylist');
    if (drawerBtnMylist) {
      drawerBtnMylist.addEventListener('click', () => {
        closeMenuDrawer();
        switchView('mylist');
      });
    }

    const drawerBtnQuiz = document.getElementById('drawerBtnQuiz');
    if (drawerBtnQuiz) {
      drawerBtnQuiz.addEventListener('click', () => {
        closeMenuDrawer();
        switchView('quiz');
      });
    }

    const drawerBtnLogin = document.getElementById('drawerBtnLogin');
    if (drawerBtnLogin) {
      drawerBtnLogin.addEventListener('click', () => {
        closeMenuDrawer();
        document.getElementById('loginModal').classList.remove('hidden');
      });
    }

    const drawerBtnLogout = document.getElementById('drawerBtnLogout');
    if (drawerBtnLogout) {
      drawerBtnLogout.addEventListener('click', () => {
        closeMenuDrawer();
        setStudent(null);
        showToast('Logged out / ログアウトしました');
      });
    }

    const drawerBtnHelpGuide = document.getElementById('drawerBtnHelpGuide');
    if (drawerBtnHelpGuide) {
      drawerBtnHelpGuide.addEventListener('click', () => {
        closeMenuDrawer();
        openHelpGuideModal();
      });
    }

    // Language selector in Drawer (母国語設定)
    const drawerLangSelect = document.getElementById('drawerLangSelect');
    if (drawerLangSelect) {
      drawerLangSelect.addEventListener('change', (e) => {
        currentLang = e.target.value;
        applyUiLanguage(currentLang);
        renderCurrentCard();
        renderSidebarContent();
        showToast(currentLang === 'ja' ? '母国語を日本語に設定しました' : 'Native language updated');
      });
    }

    // Deck toggle: Shared vs Student Dedicated
    document.getElementById('filterAllDeck').addEventListener('click', (e) => {
      currentDeckFilter = 'all';
      e.target.className = 'px-2.5 py-1 rounded-md bg-white text-slate-800 font-bold shadow-xs';
      document.getElementById('filterMyDeck').className = 'px-2.5 py-1 rounded-md text-slate-600 font-medium';
      updateActiveDeck();
    });

    document.getElementById('filterMyDeck').addEventListener('click', (e) => {
      if (!currentStudent) {
        showToast('Please log in with student credentials');
        document.getElementById('loginModal').classList.remove('hidden');
        return;
      }
      currentDeckFilter = 'mine';
      e.target.className = 'px-2.5 py-1 rounded-md bg-white text-slate-800 font-bold shadow-xs';
      document.getElementById('filterAllDeck').className = 'px-2.5 py-1 rounded-md text-slate-600 font-medium';
      updateActiveDeck();
    });

    // Flip card click
    document.getElementById('flashcardElement').addEventListener('click', (e) => {
      // Prevent flipping if clicked on button or if user is selecting text in example
      if (e.target.closest('button')) return;
      // If user performed a drag / swipe gesture, do not flip
      if (hasMovedBeyondTapThreshold) {
        hasMovedBeyondTapThreshold = false;
        return;
      }
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;
      if (e.target.closest('#exampleTextContainer')) return;
      flipCard();
    });

    // Reverse Mode (Front: Japanese ⇄ Native)
    document.getElementById('btnToggleReverse').addEventListener('click', () => {
      isReverseMode = !isReverseMode;
      const reverseLabel = document.getElementById('reverseModeLabel');
      if (reverseLabel) {
        if (currentLang === 'ja') {
          reverseLabel.textContent = isReverseMode ? '表面: 母国語' : '表面: 日本語';
        } else {
          reverseLabel.textContent = isReverseMode ? 'Front: Native' : 'Front: Japanese';
        }
      }
      renderCurrentCard();
    });

    // Folder & Unit Navigation Listeners
    document.getElementById('btnBackToFolders').addEventListener('click', backToFolderOverview);
    document.getElementById('btnStudyEntireFolder').addEventListener('click', startStudyingEntireFolder);
    document.getElementById('btnChangeUnit').addEventListener('click', () => {
      if (isSearchStudyMode) {
        // Return directly to folder overview from a search result card
        backToFolderOverview();
      } else {
        // Return to units list of current folder
        openFolderUnits(currentFolder === 'all' ? 'folder_1' : currentFolder);
      }
    });

    // Shuffle current unit or current deck
    document.getElementById('btnShuffleCurrent').addEventListener('click', () => {
      if (activeDeck.length === 0) {
        showToast('No cards in this deck');
        return;
      }
      activeDeck.sort(() => Math.random() - 0.5);
      currentIndex = 0;
      renderCurrentCard();
      showToast('Shuffled current deck 🔀');
    });

    // Shuffle ALL cards
    document.getElementById('btnShuffleAll').addEventListener('click', () => {
      currentFolder = 'all';
      currentSection = 'all';
      const isJa = currentLang === 'ja';
      document.getElementById('activeStudySectionName').textContent = isJa ? '全単元 (全シャッフル)' : 'All Units (Shuffle All)';
      document.getElementById('activeStudyFolderName').textContent = isJa ? 'カリキュラム一覧' : 'Curriculum';
      document.getElementById('folderOverviewPanel').classList.add('hidden');
      document.getElementById('unitListPanel').classList.add('hidden');
      document.getElementById('activeStudyHeader').classList.remove('hidden');

      updateActiveDeck();
      activeDeck.sort(() => Math.random() - 0.5);
      currentIndex = 0;
      renderCurrentCard();
      showToast(isJa ? '全単元をシャッフルしました！🔀' : 'Shuffled all curriculum cards! 🔀');
    });

    // Prev / Next Card Controls
    document.getElementById('btnPrev').addEventListener('click', () => {
      if (currentIndex > 0) {
        currentIndex--;
        renderCurrentCard();
      } else {
        showToast('First card');
      }
    });

    document.getElementById('btnNext').addEventListener('click', () => {
      if (currentIndex < activeDeck.length - 1) {
        currentIndex++;
        renderCurrentCard();
      } else {
        showToast('Last card! Try taking a quiz 🎉');
      }
    });

    // Star / Mylist Toggle on current card
    document.getElementById('btnStarCurrent').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!activeDeck[currentIndex]) return;
      const card = activeDeck[currentIndex];
      promptFolderSelectAndAdd(card, () => {
        renderCurrentCard();
      });
    });

    // --- Card Marking Helpers (覚えた！ & もう一度！) ---
    function markCardLearned(cardToMark = null) {
      const card = cardToMark || activeDeck[currentIndex];
      if (!card) return;
      const LEARNED_FOLDER_ID = 'folder_learned';
      const LEARNED_FOLDER_NAME = '覚えた！';

      // フォルダ存在確認
      if (!mylistFolders.find(f => f.id === LEARNED_FOLDER_ID || f.name === LEARNED_FOLDER_NAME)) {
        mylistFolders.push({ id: LEARNED_FOLDER_ID, name: LEARNED_FOLDER_NAME });
      }

      // マイリストに追加＆フォルダ割り当て
      mylistSet.add(card.id);
      mylistCardFolderMap[card.id] = LEARNED_FOLDER_ID;
      knownSet.add(card.id);
      saveMylistForCurrentStudent();

      showToast(currentLang === 'ja' ? `「${card.word}」を『覚えた！』に保存しました ✨` : `Saved "${card.word}" to Learned! ✨`);

      // 自動的に次のカードへ進む
      if (currentIndex < activeDeck.length - 1) {
        currentIndex++;
        renderCurrentCard();
      } else {
        renderCurrentCard();
        showToast(currentLang === 'ja' ? '最後のカードです！お疲れ様でした 🎉' : 'Last card! Great job 🎉');
      }
    }

    function markCardReview(cardToMark = null) {
      const card = cardToMark || activeDeck[currentIndex];
      if (!card) return;
      const REVIEW_FOLDER_ID = 'folder_review';
      const REVIEW_FOLDER_NAME = 'もう一度！';

      // フォルダ存在確認
      if (!mylistFolders.find(f => f.id === REVIEW_FOLDER_ID || f.name === REVIEW_FOLDER_NAME)) {
        mylistFolders.push({ id: REVIEW_FOLDER_ID, name: REVIEW_FOLDER_NAME });
      }

      // マイリストに追加＆フォルダ割り当て
      mylistSet.add(card.id);
      mylistCardFolderMap[card.id] = REVIEW_FOLDER_ID;
      knownSet.delete(card.id); // まだ覚えていないので既習フラグを外す
      saveMylistForCurrentStudent();

      showToast(currentLang === 'ja' ? `「${card.word}」を『もう一度！』に保存しました 🔁` : `Saved "${card.word}" to Review again! 🔁`);

      // 自動的に次のカードへ進む
      if (currentIndex < activeDeck.length - 1) {
        currentIndex++;
        renderCurrentCard();
      } else {
        renderCurrentCard();
        showToast(currentLang === 'ja' ? '最後のカードです！もう一度復習しましょう 🔁' : 'Last card! Review again 🔁');
      }
    }

    // 「覚えた！」ボタン (右側): マイリストに追加し「覚えた！」フォルダに保存して次のカードへ進む
    const btnMarkKnown = document.getElementById('btnMarkKnown');
    if (btnMarkKnown) {
      btnMarkKnown.addEventListener('click', () => markCardLearned());
    }

    // 「もう一度！」ボタン (左側): マイリストに追加し「もう一度！」フォルダに保存して次のカードへ進む
    const btnMarkReview = document.getElementById('btnMarkReview');
    if (btnMarkReview) {
      btnMarkReview.addEventListener('click', () => markCardReview());
    }

    // --- スマホ版スワイプ操作 (右スワイプ: 覚えた！ / 左スワイプ: もう一回！) ---
    const flashcardEl = document.getElementById('flashcardElement');
    const badgeLearned = document.getElementById('swipeBadgeLearned');
    const badgeReview = document.getElementById('swipeBadgeReview');

    let touchStartX = 0;
    let touchStartY = 0;
    let touchCurrentX = 0;
    let touchCurrentY = 0;
    let isSwiping = false;
    hasMovedBeyondTapThreshold = false;

    if (flashcardEl) {
      flashcardEl.addEventListener('touchstart', (e) => {
        // ボタンやテキスト選択エリアでのタッチは無視
        if (e.target.closest('button') || e.target.closest('#exampleTextContainer')) return;
        const touch = e.touches[0];
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
        touchCurrentX = touch.clientX;
        touchCurrentY = touch.clientY;
        isSwiping = true;
        hasMovedBeyondTapThreshold = false;
      }, { passive: true });

      flashcardEl.addEventListener('touchmove', (e) => {
        if (!isSwiping || !activeDeck[currentIndex]) return;
        const touch = e.touches[0];
        touchCurrentX = touch.clientX;
        touchCurrentY = touch.clientY;

        const deltaX = touchCurrentX - touchStartX;
        const deltaY = touchCurrentY - touchStartY;

        // タップ判定の閾値（8px以上動いたらスワイプ動作とみなす）
        if (Math.abs(deltaX) > 8 || Math.abs(deltaY) > 8) {
          hasMovedBeyondTapThreshold = true;
        }

        // 横スワイプが縦スクロールより優勢な場合にカードを物理的に追従
        if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 12) {
          // 水平スクロールをキャンセル
          if (e.cancelable) e.preventDefault();

          const rotation = (deltaX / 18); // 傾き効果
          const baseRotateY = isCardFlipped ? 180 : 0;
          flashcardEl.style.transition = 'none';
          flashcardEl.style.transform = `translateX(${deltaX}px) rotate(${rotation}deg) rotateY(${baseRotateY}deg)`;

          // バッジの透明度調整 (50px〜120pxでフェードイン)
          if (deltaX > 25) {
            // 右スワイプ: 覚えた！
            const opacity = Math.min(1, (deltaX - 25) / 60);
            if (badgeLearned) badgeLearned.style.opacity = opacity;
            if (badgeReview) badgeReview.style.opacity = '0';
          } else if (deltaX < -25) {
            // 左スワイプ: もう一回！
            const opacity = Math.min(1, (Math.abs(deltaX) - 25) / 60);
            if (badgeReview) badgeReview.style.opacity = opacity;
            if (badgeLearned) badgeLearned.style.opacity = '0';
          } else {
            if (badgeLearned) badgeLearned.style.opacity = '0';
            if (badgeReview) badgeReview.style.opacity = '0';
          }
        }
      }, { passive: false });

      const handleTouchEnd = (e) => {
        if (!isSwiping) return;
        isSwiping = false;

        const deltaX = touchCurrentX - touchStartX;
        const deltaY = touchCurrentY - touchStartY;
        const SWIPE_THRESHOLD = 75; // スワイプ成立とみなす移動距離 (px)
        const baseRotateY = isCardFlipped ? 180 : 0;

        // バッジリセット
        if (badgeLearned) badgeLearned.style.opacity = '0';
        if (badgeReview) badgeReview.style.opacity = '0';

        // スワイプ成立判定 (横方向が優勢かつ閾値超え)
        if (Math.abs(deltaX) > SWIPE_THRESHOLD && Math.abs(deltaX) > Math.abs(deltaY)) {
          if (deltaX > 0) {
            // ★ 右スワイプ: 「覚えた！」
            flashcardEl.style.transition = 'transform 0.25s cubic-bezier(0.2, 0.8, 0.4, 1), opacity 0.25s ease';
            flashcardEl.style.transform = `translateX(120%) rotate(25deg) rotateY(${baseRotateY}deg)`;
            flashcardEl.style.opacity = '0';

            setTimeout(() => {
              flashcardEl.style.transition = 'none';
              flashcardEl.style.transform = `rotateY(${baseRotateY}deg)`;
              flashcardEl.style.opacity = '1';
              markCardLearned();
            }, 250);
          } else {
            // ★ 左スワイプ: 「もう一回！」
            flashcardEl.style.transition = 'transform 0.25s cubic-bezier(0.2, 0.8, 0.4, 1), opacity 0.25s ease';
            flashcardEl.style.transform = `translateX(-120%) rotate(-25deg) rotateY(${baseRotateY}deg)`;
            flashcardEl.style.opacity = '0';

            setTimeout(() => {
              flashcardEl.style.transition = 'none';
              flashcardEl.style.transform = `rotateY(${baseRotateY}deg)`;
              flashcardEl.style.opacity = '1';
              markCardReview();
            }, 250);
          }
        } else {
          // スワイプキャンセル: 元の位置にスムーズに戻す
          flashcardEl.style.transition = 'transform 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
          flashcardEl.style.transform = `translateX(0px) rotate(0deg) rotateY(${baseRotateY}deg)`;
        }
      };

      flashcardEl.addEventListener('touchend', handleTouchEnd);
      flashcardEl.addEventListener('touchcancel', handleTouchEnd);
    }

    // Speech Audio buttons
    document.getElementById('btnSpeakFront').addEventListener('click', (e) => {
      e.stopPropagation();
      if (activeDeck[currentIndex]) {
        toggleJapaneseSpeech(activeDeck[currentIndex]);
      }
    });

    document.getElementById('btnSpeakBack').addEventListener('click', (e) => {
      e.stopPropagation();
      if (activeDeck[currentIndex]) {
        toggleJapaneseSpeech(activeDeck[currentIndex]);
      }
    });

    document.getElementById('btnSpeakExample').addEventListener('click', (e) => {
      e.stopPropagation();
      if (activeDeck[currentIndex] && activeDeck[currentIndex].example) {
        toggleJapaneseSpeech(activeDeck[currentIndex].example.ja);
      }
    });

    // Quiz Scope Switchers (Current Unit / My List / Shuffle All)
    const btnQuizScopeCur = document.getElementById('btnQuizScopeCurrent');
    if (btnQuizScopeCur) {
      btnQuizScopeCur.addEventListener('click', () => {
        quizScope = 'current';
        startQuiz();
        showToast('Quiz set to: Current Unit / Deck');
      });
    }

    const btnQuizScopeMy = document.getElementById('btnQuizScopeMylist');
    if (btnQuizScopeMy) {
      btnQuizScopeMy.addEventListener('click', () => {
        quizScope = 'mylist';
        startQuiz();
        const folderObj = mylistFolders.find(f => f.id === activeMylistFolderId);
        showToast(folderObj ? `Quiz set to: My List 📁 ${folderObj.name}` : 'Quiz set to: My List (All)');
      });
    }

    const btnQuizScopeAl = document.getElementById('btnQuizScopeAll');
    if (btnQuizScopeAl) {
      btnQuizScopeAl.addEventListener('click', () => {
        quizScope = 'all';
        startQuiz();
        showToast('Quiz set to: Shuffle All Units');
      });
    }

    // Direct Test button on active study header
    const btnTestCur = document.getElementById('btnTestCurrent');
    if (btnTestCur) {
      btnTestCur.addEventListener('click', () => {
        startQuizWithScope('current', currentSection, document.getElementById('activeStudySectionName')?.textContent);
      });
    }

    // Direct Test button on folder overview panel
    const btnTestEntireFld = document.getElementById('btnTestEntireFolder');
    if (btnTestEntireFld) {
      btnTestEntireFld.addEventListener('click', () => {
        const fc = FOLDER_CONFIGS.find(f => f.id === currentFolder);
        startQuizWithScope('folder', currentFolder, fc ? fc.title : 'フォルダ全体');
      });
    }

    // Quiz Next Button
    document.getElementById('btnQuizNext').addEventListener('click', () => {
      quizIndex++;
      renderQuizQuestion();
    });

    // Toggle Folders Dropdown in Mylist
    const btnToggleFolders = document.getElementById('btnToggleMylistFolders');
    const foldersContainer = document.getElementById('mylistFoldersDropdownContainer');
    const arrowIcon = document.getElementById('iconToggleFoldersArrow');
    if (btnToggleFolders && foldersContainer) {
      btnToggleFolders.addEventListener('click', () => {
        const isHidden = foldersContainer.classList.contains('hidden');
        foldersContainer.classList.toggle('hidden', !isHidden);
        if (arrowIcon) {
          arrowIcon.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
        }
      });
    }

    // Create New Custom Folder in Mylist
    const btnCreateFolder = document.getElementById('btnCreateMylistFolder');
    if (btnCreateFolder) {
      btnCreateFolder.addEventListener('click', () => {
        const folderName = window.prompt('Enter new folder name (e.g. N5 Verbs, Travel Phrases, Exam Prep):');
        if (!folderName || !folderName.trim()) return;
        const trimmed = folderName.trim();
        const newFolderId = `mf_${Date.now()}`;
        mylistFolders.push({ id: newFolderId, name: trimmed });
        activeMylistFolderId = newFolderId;
        saveMylistForCurrentStudent();
        renderMylistView();
        showToast(`Created folder "${trimmed}" 📁`);
      });
    }

    // Rename Custom Folder
    const btnRenameFolder = document.getElementById('btnRenameMylistFolder');
    if (btnRenameFolder) {
      btnRenameFolder.addEventListener('click', () => {
        if (activeMylistFolderId === 'all') return;
        const folder = mylistFolders.find(f => f.id === activeMylistFolderId);
        if (!folder) return;
        const newName = window.prompt('Enter new folder name:', folder.name);
        if (!newName || !newName.trim()) return;
        folder.name = newName.trim();
        saveMylistForCurrentStudent();
        renderMylistView();
        showToast('Folder renamed ✨');
      });
    }

    // Delete Custom Folder
    const btnDeleteFolder = document.getElementById('btnDeleteMylistFolder');
    if (btnDeleteFolder) {
      btnDeleteFolder.addEventListener('click', () => {
        if (activeMylistFolderId === 'all') return;
        const folder = mylistFolders.find(f => f.id === activeMylistFolderId);
        if (!folder) return;
        if (!confirm(`Delete folder "${folder.name}"?\n(Words will remain in My List)`)) return;
        
        // Remove folder and unassign cards from it
        mylistFolders = mylistFolders.filter(f => f.id !== folder.id);
        Object.keys(mylistCardFolderMap).forEach(cardId => {
          if (mylistCardFolderMap[cardId] === folder.id) {
            delete mylistCardFolderMap[cardId];
          }
        });
        activeMylistFolderId = 'all';
        saveMylistForCurrentStudent();
        renderMylistView();
        showToast('Folder deleted');
      });
    }

    // Mylist Study button (Studies active folder, or all if 'all' is selected)
    document.getElementById('btnStudyMylist').addEventListener('click', () => {
      let targetCards = getMylistCards();
      if (activeMylistFolderId !== 'all') {
        targetCards = targetCards.filter(c => mylistCardFolderMap[c.id] === activeMylistFolderId);
      }
      if (targetCards.length === 0) {
        showToast(currentLang === 'ja' ? '学習する単語がありません' : 'No words to study');
        return;
      }
      const folderObj = mylistFolders.find(f => f.id === activeMylistFolderId);
      const folderName = folderObj ? folderObj.name : (currentLang === 'ja' ? 'マイリスト全体' : 'My List (All)');

      activeDeck = targetCards;
      currentIndex = 0;
      isSearchStudyMode = true; // Allows back button to return gracefully

      switchView('flashcards');

      // Setup active study header
      document.getElementById('folderOverviewPanel').classList.add('hidden');
      document.getElementById('unitListPanel').classList.add('hidden');
      document.getElementById('activeStudyHeader').classList.remove('hidden');
      document.getElementById('activeStudySectionName').textContent = folderName;
      renderCurrentCard();
      let startMsg = `「${folderName}」の練習カードを開始します ⭐`;
      if (currentLang === 'zh_TW' || currentLang === 'zh_HK') startMsg = `開始「${folderName}」的練習卡片 ⭐`;
      else if (currentLang === 'zh_CN') startMsg = `开始「${folderName}」的练习卡片 ⭐`;
      else if (currentLang === 'ko') startMsg = `"${folderName}" 연습 카드를 시작합니다 ⭐`;
      else if (currentLang === 'fr') startMsg = `Début de la pratique des cartes pour « ${folderName} » ⭐`;
      else if (currentLang !== 'ja') startMsg = `Practicing "${folderName}" cards ⭐`;
      showToast(startMsg);
    });

    // Mylist Test button (Quizzes active folder, or all if 'all' is selected)
    const btnTestMy = document.getElementById('btnTestMylist');
    if (btnTestMy) {
      btnTestMy.addEventListener('click', () => {
        let targetCards = getMylistCards();
        if (activeMylistFolderId !== 'all') {
          targetCards = targetCards.filter(c => mylistCardFolderMap[c.id] === activeMylistFolderId);
        }
        if (targetCards.length < 2) {
          showToast('At least 2 words are required to start a test');
          return;
        }
        const folderObj = mylistFolders.find(f => f.id === activeMylistFolderId);
        startQuizWithScope('mylist', activeMylistFolderId, folderObj ? `My List: 📁${folderObj.name}` : 'My List (All)');
      });
    }

    // Admin execute import
    document.getElementById('btnExecuteImport').addEventListener('click', executeImport);

    // Help guide modal toggle & slide controls
    const btnHelpGuide = document.getElementById('btnHelpGuide');
    if (btnHelpGuide) {
      btnHelpGuide.addEventListener('click', openHelpGuideModal);
    }
    const btnHelpGuidePrev = document.getElementById('btnHelpGuidePrev');
    if (btnHelpGuidePrev) {
      btnHelpGuidePrev.addEventListener('click', prevHelpGuideSlide);
    }
    const btnHelpGuideNext = document.getElementById('btnHelpGuideNext');
    if (btnHelpGuideNext) {
      btnHelpGuideNext.addEventListener('click', nextHelpGuideSlide);
    }

    // Mobile shuffle all button
    const btnShuffleAllMobile = document.getElementById('btnShuffleAllMobile');
    if (btnShuffleAllMobile) {
      btnShuffleAllMobile.addEventListener('click', () => {
        document.getElementById('btnShuffleAll')?.click();
      });
    }

    // Login modal toggles
    document.getElementById('userBtn').addEventListener('click', () => {
      document.getElementById('loginModal').classList.remove('hidden');
    });

    document.getElementById('btnLoginCancel').addEventListener('click', () => {
      document.getElementById('loginModal').classList.add('hidden');
    });

    document.getElementById('btnLoginSubmit').addEventListener('click', async () => {
      const studentIdInput = document.getElementById('loginStudentId').value.trim();
      const passcodeInput = document.getElementById('loginPasscode').value.trim();

      // Check if user is logging in as Haku-sensei / Admin using the new passcode ppooii0099
      if (passcodeInput === 'ppooii0099' && (!studentIdInput || studentIdInput === 'haku' || studentIdInput === 'ハク' || studentIdInput === 'admin' || studentIdInput === '先生')) {
        let teacherUser = students.find(s => s.id === 'haku');
        if (!teacherUser) {
          teacherUser = { id: 'haku', name: 'ハク先生', lang: 'ja', passcode: 'ppooii0099' };
          students.unshift(teacherUser);
          localStorage.setItem('haku_students', JSON.stringify(students));
        }
        setStudent(teacherUser);
        document.getElementById('loginModal').classList.add('hidden');
        showToast('ハク先生としてログインしました！🌸');
        return;
      }

      let student = students.find(s => 
        (s.id.toLowerCase() === studentIdInput.toLowerCase() || s.name.toLowerCase() === studentIdInput.toLowerCase()) &&
        s.passcode === passcodeInput
      );

      // If not matched locally, attempt Cloud Firebase authentication check
      if (!student && isFirebaseReady && fbAuth && studentIdInput) {
        try {
          const authSuccess = await ensureStudentCloudAuth(studentIdInput, passcodeInput);
          if (authSuccess) {
            // Find existing student entry or create placeholder entry
            student = students.find(s => s.id.toLowerCase() === studentIdInput.toLowerCase());
            if (!student) {
              student = { id: studentIdInput, name: `生徒${studentIdInput}`, lang: 'en', passcode: passcodeInput };
              students.push(student);
              localStorage.setItem('haku_students', JSON.stringify(students));
            } else {
              student.passcode = passcodeInput;
              localStorage.setItem('haku_students', JSON.stringify(students));
            }
          }
        } catch (authErr) {
          console.warn('Cloud login attempt error:', authErr);
        }
      }

      if (student) {
        setStudent(student);
        document.getElementById('loginModal').classList.add('hidden');
      } else {
        showToast('Invalid Student ID or passcode');
      }
    });

    const btnLoginLogout = document.getElementById('btnLoginLogout');
    if (btnLoginLogout) {
      btnLoginLogout.addEventListener('click', () => {
        setStudent(null);
        document.getElementById('loginModal').classList.add('hidden');
        showToast('Logged out / ログアウトしました');
      });
    }

    // Add new student button in admin (Opens modal with auto-suggested ID and passcode)
    const btnAddNewStudent = document.getElementById('btnAddNewStudent');
    const addStudentModal = document.getElementById('addStudentModal');
    const nameInput = document.getElementById('newStudentNameInput');
    const idInput = document.getElementById('newStudentIdInput');
    const passcodeInput = document.getElementById('newStudentPasscodeInput');
    const langSelect = document.getElementById('newStudentLangSelect');
    const btnCancelAddStudent = document.getElementById('btnCancelAddStudent');
    const btnSaveNewStudent = document.getElementById('btnSaveNewStudent');

    if (btnAddNewStudent && addStudentModal) {
      btnAddNewStudent.addEventListener('click', () => {
        // Calculate next numeric ID e.g. 0022
        const numericIds = students
          .map(s => parseInt(s.id, 10))
          .filter(n => !isNaN(n));
        const nextNum = numericIds.length > 0 ? Math.max(...numericIds) + 1 : 1;
        const nextIdStr = String(nextNum).padStart(4, '0');
        // Generate memorable paired digits (e.g. 1122, 2233, 3344, 4455, 5566...)
        const d1 = (nextNum % 9) + 1;
        const d2 = ((nextNum + 1) % 9) + 1;
        const nextPasscodeStr = `${d1}${d1}${d2}${d2}`;

        if (nameInput) nameInput.value = '';
        if (idInput) idInput.value = nextIdStr;
        if (passcodeInput) passcodeInput.value = nextPasscodeStr;
        if (langSelect) langSelect.value = 'en';

        addStudentModal.classList.remove('hidden');
        if (nameInput) nameInput.focus();
      });
    }

    if (btnCancelAddStudent && addStudentModal) {
      btnCancelAddStudent.addEventListener('click', () => {
        addStudentModal.classList.add('hidden');
      });
    }

    if (btnSaveNewStudent && addStudentModal) {
      btnSaveNewStudent.addEventListener('click', () => {
        const nameVal = nameInput ? nameInput.value.trim() : '';
        const idVal = idInput ? idInput.value.trim() : '';
        const pinVal = passcodeInput ? passcodeInput.value.trim() : '';
        const langVal = langSelect ? langSelect.value : 'en';

        if (!nameVal) {
          showToast('生徒の名前を入力してください');
          if (nameInput) nameInput.focus();
          return;
        }

        if (!idVal) {
          showToast('生徒IDを入力してください');
          return;
        }

        if (!pinVal || pinVal.length < 4) {
          showToast('4桁のパスコードを入力してください');
          return;
        }

        // Check if ID is duplicate
        if (students.some(s => s.id.toLowerCase() === idVal.toLowerCase())) {
          showToast('この生徒IDは既に使用されています');
          return;
        }

        const newStudent = {
          id: idVal,
          name: nameVal,
          lang: langVal,
          passcode: pinVal
        };

        students.push(newStudent);
        localStorage.setItem('haku_students', JSON.stringify(students));

        // Initialize empty "授業で習った言葉" folder for this new student
        const CLASS_FOLDER_ID = 'folder_class_words';
        const CLASS_FOLDER_NAME = '授業で習った言葉';
        const foldersKey = `haku_mylist_folders_${idVal}`;
        localStorage.setItem(foldersKey, JSON.stringify([{ id: CLASS_FOLDER_ID, name: CLASS_FOLDER_NAME }]));

        renderAdminStudentList();
        addStudentModal.classList.add('hidden');
        showToast(`生徒「${nameVal}」（ID: ${idVal} / PIN: ${pinVal}）を追加しました！✨`);
        alert(`【新規生徒アカウント発行完了】\n\n生徒名: ${nameVal}\n生徒ID: ${idVal}\nパスコード (PIN): ${pinVal}\n\n※このパスコードは先生用管理画面の「生徒アカウント一覧」でもいつでも確認できます。`);
      });
    }

    // --- Edit Student Modal Handling ---
    const editStudentModal = document.getElementById('editStudentModal');
    const editIdInput = document.getElementById('editStudentIdInput');
    const editNameInput = document.getElementById('editStudentNameInput');
    const editPasscodeInput = document.getElementById('editStudentPasscodeInput');
    const editLangSelect = document.getElementById('editStudentLangSelect');
    const btnCancelEditStudent = document.getElementById('btnCancelEditStudent');
    const btnSaveEditStudent = document.getElementById('btnSaveEditStudent');
    let studentBeingEdited = null;

    window.openEditStudentModal = function(studentObj) {
      if (!studentObj || !editStudentModal) return;
      studentBeingEdited = studentObj;
      if (editIdInput) editIdInput.value = studentObj.id;
      if (editNameInput) editNameInput.value = studentObj.name;
      if (editPasscodeInput) editPasscodeInput.value = studentObj.passcode;
      if (editLangSelect) editLangSelect.value = studentObj.lang || 'en';
      editStudentModal.classList.remove('hidden');
      if (editNameInput) editNameInput.focus();
    };

    if (btnCancelEditStudent && editStudentModal) {
      btnCancelEditStudent.addEventListener('click', () => {
        editStudentModal.classList.add('hidden');
        studentBeingEdited = null;
      });
    }

    if (btnSaveEditStudent && editStudentModal) {
      btnSaveEditStudent.addEventListener('click', async () => {
        if (!studentBeingEdited) return;
        const newName = editNameInput ? editNameInput.value.trim() : '';
        const newPin = editPasscodeInput ? editPasscodeInput.value.trim() : '';
        const newLang = editLangSelect ? editLangSelect.value : 'en';

        if (!newName) {
          showToast('生徒の名前を入力してください');
          if (editNameInput) editNameInput.focus();
          return;
        }

        if (!newPin || newPin.length < 4) {
          showToast('4桁以上のパスコードを入力してください');
          if (editPasscodeInput) editPasscodeInput.focus();
          return;
        }

        const oldPin = studentBeingEdited.passcode;
        const studentId = studentBeingEdited.id;

        // 1. Update in-memory and local storage
        studentBeingEdited.name = newName;
        studentBeingEdited.passcode = newPin;
        studentBeingEdited.lang = newLang;

        // Update in students array
        const idx = students.findIndex(s => s.id === studentId);
        if (idx !== -1) {
          students[idx] = { ...studentBeingEdited };
        }
        localStorage.setItem('haku_students', JSON.stringify(students));

        // If currently logged-in student is this student, update session info
        if (currentStudent && currentStudent.id === studentId) {
          currentStudent.name = newName;
          currentStudent.passcode = newPin;
          currentStudent.lang = newLang;
          document.getElementById('headerStudentBadge').textContent = `Student: ${newName}`;
          const drawerName = document.getElementById('drawerStudentName');
          if (drawerName) drawerName.textContent = newName;
        }

        // 2. Synchronize new password to Firebase Cloud Auth behind the scenes
        if (isFirebaseReady && fbAuth && studentId !== 'haku' && studentId !== 'admin') {
          try {
            const virtualEmail = `${studentId.toLowerCase()}@haku.local`;
            const oldPasswordStr = `haku_${oldPin}_sec`;
            const newPasswordStr = `haku_${newPin}_sec`;

            // Try signing in with old passcode to update to new passcode
            try {
              const userCred = await fbAuth.signInWithEmailAndPassword(virtualEmail, oldPasswordStr);
              if (userCred && userCred.user) {
                await userCred.user.updatePassword(newPasswordStr);
                console.log(`Cloud password updated for student ${studentId} ☁️🔑`);
              }
            } catch (authErr) {
              // If not found or couldn't sign in, attempt account creation with new passcode
              if (authErr.code === 'auth/user-not-found' || authErr.code === 'auth/invalid-credential') {
                try {
                  await fbAuth.createUserWithEmailAndPassword(virtualEmail, newPasswordStr);
                  console.log(`New cloud account created with updated password for ${studentId} ☁️`);
                } catch (cErr) {}
              }
            }
          } catch (cloudErr) {
            console.warn('Cloud password sync notice:', cloudErr);
          }
        }

        renderAdminStudentList();
        editStudentModal.classList.add('hidden');
        showToast(`生徒「${newName}」（ID: ${studentId}）の情報を更新しました！✏️✨`);
      });
    }
  }


  // =========================================================================
  // ★ 写真完全再現: 例文の文字選択 ＆ 辞書で調べる / マイリスト保存ポップアップ
  // =========================================================================

  let currentSelectedExampleWord = '';
  let currentSelectedExampleReading = '';

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function sanitizeSelectedWordText(raw) {
    if (!raw) return '';
    let t = raw.replace(/<rt>.*?<\/rt>/gi, '')
               .replace(/<[^>]+>/g, '')
               .trim();
    // 句読点、記号、かっこなどを除去
    t = t.replace(/^[、。！？!?「」『』（）()[\]\s…・:：;；〜~\-\—]+|[、。！？!?「」『』（）()[\]\s…・:：;；〜~\-\—]+$/g, '');
    return t;
  }

  // 例文から重要単語チップ（ボタン）を自動抽出して表示
  function extractKeywordsFromExampleHtml(htmlText) {
    if (!htmlText) return [];
    const candidates = [];
    const seen = new Set();

    // 1. <ruby>漢字<rt>読み</rt></ruby> から漢字単語と読みを抽出
    const rubyRegex = /<ruby>([^<]+)<rt>([^<]+)<\/rt><\/ruby>/g;
    let m;
    while ((m = rubyRegex.exec(htmlText)) !== null) {
      const k = m[1].trim();
      const r = m[2].trim();
      if (k && !seen.has(k)) {
        seen.add(k);
        candidates.push({ word: k, reading: r });
      }
    }

    // 2. 漢字熟語（2文字以上）やカタカナ単語（2文字以上）を抽出
    const plain = htmlText.replace(/<rt>.*?<\/rt>/g, '').replace(/<[^>]+>/g, '');
    const kanjiMatches = plain.match(/[一-龥]{2,}/g) || [];
    const katakanaMatches = plain.match(/[゠-ヿ]{2,}/g) || [];

    [...kanjiMatches, ...katakanaMatches].forEach(w => {
      const clean = w.trim();
      if (clean && !seen.has(clean) && clean.length >= 2) {
        seen.add(clean);
        candidates.push({ word: clean, reading: '' });
      }
    });

    return candidates.slice(0, 6);
  }

  function renderExampleWordChips(exampleHtml) {
    const container = document.getElementById('exampleWordChipsContainer');
    const list = document.getElementById('exampleWordChipsList');
    if (!container || !list) return;

    const chips = extractKeywordsFromExampleHtml(exampleHtml);
    if (!chips || chips.length === 0) {
      container.classList.add('hidden');
      list.innerHTML = '';
      return;
    }

    container.classList.remove('hidden');
    list.innerHTML = chips.map(c => {
      return `
        <button class="btn-example-word-chip px-2 py-0.5 rounded-lg border border-sky-300 bg-sky-50 hover:bg-sky-100 text-sky-800 text-[11px] font-bold cursor-pointer transition shadow-2xs active:scale-95" 
          data-word="${escapeHtml(c.word)}" 
          data-reading="${escapeHtml(c.reading || '')}"
          title="タップして辞書で調べる">
          ${escapeHtml(c.word)}
        </button>
      `;
    }).join('');

    list.querySelectorAll('.btn-example-word-chip').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); // カード反転を防止
        const w = btn.getAttribute('data-word');
        const r = btn.getAttribute('data-reading') || '';
        openDictLookupModal(w, r);
      });
    });
  }

  // 例文のテキスト選択ツールバー（なぞった文字の真上に浮き出る黒い操作バー）
  function initExampleSelectionToolbar() {
    const area = document.getElementById('exampleTextContainer');
    const toolbar = document.getElementById('textSelectionToolbar');
    const previewEl = document.getElementById('selectionTextPreview');
    const btnDict = document.getElementById('btnToolbarDict');
    const btnSave = document.getElementById('btnToolbarMylist');

    if (!area || !toolbar) return;

    function updateToolbar() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        toolbar.classList.add('hidden');
        toolbar.classList.remove('flex');
        return;
      }

      const range = sel.getRangeAt(0);
      if (!area.contains(range.commonAncestorContainer)) {
        toolbar.classList.add('hidden');
        toolbar.classList.remove('flex');
        return;
      }

      const rawText = sel.toString();
      const cleaned = sanitizeSelectedWordText(rawText);
      if (!cleaned || cleaned.length > 30) {
        toolbar.classList.add('hidden');
        toolbar.classList.remove('flex');
        return;
      }

      // ルビ付き要素なら読み仮名も自動取得
      let hintReading = '';
      try {
        let node = range.commonAncestorContainer;
        if (node.nodeType === 3) node = node.parentElement;
        const rubyEl = node ? node.closest('ruby') : null;
        if (rubyEl) {
          const rt = rubyEl.querySelector('rt');
          if (rt) hintReading = rt.innerText.trim();
        }
      } catch (e) {}

      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        toolbar.classList.add('hidden');
        toolbar.classList.remove('flex');
        return;
      }

      currentSelectedExampleWord = cleaned;
      currentSelectedExampleReading = hintReading;

      if (previewEl) previewEl.textContent = cleaned;

      toolbar.classList.remove('hidden');
      toolbar.classList.add('flex');

      // 画面上部や左右にはみ出さないよう座標を補正
      const top = Math.max(10, rect.top - 50);
      const left = Math.min(window.innerWidth - 260, Math.max(10, rect.left + rect.width / 2 - 125));
      toolbar.style.top = `${top}px`;
      toolbar.style.left = `${left}px`;
    }

    area.addEventListener('mouseup', () => setTimeout(updateToolbar, 50));
    area.addEventListener('touchend', () => setTimeout(updateToolbar, 100));

    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        if (!toolbar.classList.contains('hidden')) {
          toolbar.classList.add('hidden');
          toolbar.classList.remove('flex');
        }
      }
    });

    if (btnDict) {
      btnDict.addEventListener('click', (e) => {
        e.stopPropagation();
        if (currentSelectedExampleWord) {
          openDictLookupModal(currentSelectedExampleWord, currentSelectedExampleReading);
          toolbar.classList.add('hidden');
          toolbar.classList.remove('flex');
        }
      });
    }

    if (btnSave) {
      btnSave.addEventListener('click', (e) => {
        e.stopPropagation();
        if (currentSelectedExampleWord) {
          quickSaveExampleWordToMylist(currentSelectedExampleWord, currentSelectedExampleReading);
          toolbar.classList.add('hidden');
          toolbar.classList.remove('flex');
        }
      });
    }
  }

  // なぞった単語をワンタップでマイリストに追加（またはフォルダ選択）
  function quickSaveExampleWordToMylist(word, hintReading) {
    const cleanWord = sanitizeSelectedWordText(word);
    if (!cleanWord) return;

    // 既存カードを探索、なければカスタム辞書カードを作成
    let card = vocabList.find(c => c.word === cleanWord || c.id === cleanWord);
    if (!card && window.CLASS_VOCAB_DATA) {
      card = window.CLASS_VOCAB_DATA.find(c => c.word === cleanWord);
    }
    if (!card && window.DICT_DATA) {
      const entry = window.DICT_DATA.find(d => d.w === cleanWord);
      if (entry) {
        card = {
          id: `dict_${entry.w}_${Date.now()}`,
          word: entry.w,
          reading: entry.r || hintReading || entry.w,
          category: entry.l ? `JLPT ${entry.l}` : '例文から保存',
          section_title: '例文から保存した単語',
          meaning: {
            en: (entry.m && entry.m.join(', ')) || '—',
            zh_TW: (entry.zh && entry.zh.join(', ')) || (entry.m && entry.m.join(', ')) || '—',
            zh_CN: (entry.zh && entry.zh.join(', ')) || (entry.m && entry.m.join(', ')) || '—',
            ko: (entry.m && entry.m.join(', ')) || '—',
            fr: (entry.fr && entry.fr.join(', ')) || (entry.m && entry.m.join(', ')) || '—'
          }
        };
      }
    }

    // 辞書にもなければ即座に新規単語として構成
    if (!card) {
      card = {
        id: `custom_ex_${cleanWord}_${Date.now()}`,
        word: cleanWord,
        reading: hintReading || cleanWord,
        category: '例文から保存',
        section_title: '例文から保存した単語',
        meaning: {
          en: cleanWord,
          zh_TW: cleanWord,
          zh_CN: cleanWord,
          ko: cleanWord,
          fr: cleanWord
        }
      };
    }

    // フォルダ選択モーダルを開いて保存
    promptFolderSelectAndAdd(card, () => {
      updateMylistBadge();
      renderCurrentCard();
    });
  }

  // 単語辞書検索 ＆ 詳細モーダル (漢字1文字や部分選択でも関連順に単語を自動提示)
  function openDictLookupModal(queryWord, hintReading) {
    if (!queryWord) return;
    const cleanWord = sanitizeSelectedWordText(queryWord);
    if (!cleanWord) return;

    const modal = document.getElementById('dictPopupModal');
    const content = document.getElementById('dictPopupModalContent');
    if (!modal || !content) return;

    // 活用語尾・語幹の自動復元リスト
    const searchCandidates = [cleanWord];
    const suffixes = ['とか', 'など', 'かった', 'くない', 'くなかった', 'くて', 'な', 'だ', 'に', 'を', 'の', 'が', 'は', 'で', 'と', 'へ', 'も', 'より', 'から', 'まで', 'して', 'した', 'する', 'され', 'ます', 'ました', 'ません', 'たい', 'たく', 'ない', 'て', 'た', 'い', 'く', 'お', 'ご'];
    for (const sfx of suffixes) {
      if (cleanWord.endsWith(sfx) && cleanWord.length > sfx.length) {
        const stem = cleanWord.slice(0, -sfx.length);
        if (stem && !searchCandidates.includes(stem)) searchCandidates.push(stem);
      }
    }
    // 活用動詞の辞書形復元（例: 呼んだ→呼ぶ、行った→行く）
    if (cleanWord.endsWith('んだ') && cleanWord.length >= 2) {
      const stem = cleanWord.slice(0, -2);
      ['ぶ', 'む', 'ぬ'].forEach(v => {
        if (!searchCandidates.includes(stem + v)) searchCandidates.push(stem + v);
      });
    }
    if (cleanWord.endsWith('った') && cleanWord.length >= 2) {
      const stem = cleanWord.slice(0, -2);
      ['う', 'つ', 'る', 'く'].forEach(v => {
        if (!searchCandidates.includes(stem + v)) searchCandidates.push(stem + v);
      });
    }

    // 選択文字列から2文字以上の部分文字列（例: 「分以上」→「以上」）を抽出
    const subWords = [];
    if (cleanWord.length >= 2) {
      for (let len = cleanWord.length - 1; len >= 2; len--) {
        for (let i = 0; i <= cleanWord.length - len; i++) {
          const sub = cleanWord.substring(i, i + len);
          if (!subWords.includes(sub) && !searchCandidates.includes(sub)) {
            subWords.push(sub);
            searchCandidates.push(sub);
          }
        }
      }
    }

    // 漢字1文字ずつのリスト（例: 「待」や「分以上」の「分」「以」「上」）
    const kanjiChars = Array.from(new Set(cleanWord.match(/[\u4e00-\u9fff]/g) || []));

    // --- 1. カリキュラム単語（vocabList）からスコアリング検索 ---
    let matchedCurriculumCards = [];
    vocabList.forEach(c => {
      let score = 0;
      if (c.word === cleanWord || (c.reading && c.reading === cleanWord)) score = 10000;
      else if (searchCandidates.includes(c.word)) score = 8000;
      else if (c.word.startsWith(cleanWord)) score = 5000 - c.word.length * 10;
      else if (c.word.includes(cleanWord)) score = 3000 - c.word.length * 10;
      else {
        for (const sub of subWords) {
          if (c.word === sub) { score = Math.max(score, 2000 - c.word.length * 5); break; }
          else if (c.word.startsWith(sub)) { score = Math.max(score, 1500 - c.word.length * 5); break; }
          else if (c.word.includes(sub)) { score = Math.max(score, 1000 - c.word.length * 5); break; }
        }
        for (const k of kanjiChars) {
          if (c.word.startsWith(k)) score = Math.max(score, 600 - c.word.length * 5);
          else if (c.word.includes(k)) score = Math.max(score, 400 - c.word.length * 5);
        }
      }
      if (score > 0) {
        matchedCurriculumCards.push({ card: c, score });
      }
    });
    matchedCurriculumCards.sort((a, b) => b.score - a.score);

    // --- 2. DICT_DATA (日本語大辞書 68,000語) からスコアリング検索 ---
    let dictScoredMatches = [];
    const seenDictKeys = new Set();
    const lvlScoreMap = { 'N5': 80, 'N4': 60, 'N3': 40, 'N2': 20, 'N1': 10 };

    if (window.DICT_DATA && Array.isArray(window.DICT_DATA)) {
      for (const d of window.DICT_DATA) {
        const w = d.w || '';
        const r = d.r || '';
        const key = `${w}_${r}`;
        if (seenDictKeys.has(key)) continue;

        let score = 0;
        if (w === cleanWord) {
          score = 10000;
        } else if (r === cleanWord) {
          score = 9000;
        } else if (searchCandidates.includes(w)) {
          score = 8000;
        } else if (w.startsWith(cleanWord)) {
          score = 5000 - w.length * 10;
        } else if (w.includes(cleanWord)) {
          score = 3000 - w.length * 10;
        } else {
          for (const sub of subWords) {
            if (w === sub) { score = Math.max(score, 2000 - w.length * 5); break; }
            else if (w.startsWith(sub)) { score = Math.max(score, 1500 - w.length * 5); break; }
            else if (w.includes(sub)) { score = Math.max(score, 1000 - w.length * 5); break; }
          }
          for (const k of kanjiChars) {
            if (w.startsWith(k)) score = Math.max(score, 600 - w.length * 5);
            else if (w.includes(k)) score = Math.max(score, 400 - w.length * 5);
          }
        }

        if (score > 0) {
          score += (lvlScoreMap[d.l] || 0);
          if (hintReading && r === hintReading) score += 500;
          seenDictKeys.add(key);
          dictScoredMatches.push({ item: d, score });
        }
      }
      dictScoredMatches.sort((a, b) => b.score - a.score);
    }

    // --- 3. 訳文取得用ヘルパー ---
    function formatDictMeaning(d) {
      const mList = (d.m || []).join(', ');
      const zhList = (d.zh || []).join(', ');
      const frList = (d.fr || []).join(', ');
      if (currentLang === 'zh_TW' || currentLang === 'zh_HK' || currentLang === 'zh_CN') {
        return zhList || mList || '—';
      }
      if (currentLang === 'fr') {
        return frList || mList || '—';
      }
      return mList || '—';
    }

    // --- 4. トップ表示する単語（完全一致、または最高スコアの代表単語）の決定 ---
    let topWord = cleanWord;
    let topReading = hintReading || '';
    let topCategory = '一般';
    let topMeaningText = '';
    let topCardForSave = null;
    let isTopFromRelated = false;

    // 完全一致または最高スコアの選定
    const bestCurriculum = matchedCurriculumCards[0];
    const bestDict = dictScoredMatches[0];

    if (bestCurriculum && bestCurriculum.score >= 8000) {
      const c = bestCurriculum.card;
      topWord = c.word;
      topReading = c.reading || hintReading || '';
      topCategory = c.category || '授業で習った言葉';
      topMeaningText = getBilingualMeaning(c.meaning, currentLang);
      topCardForSave = c;
    } else if (bestDict && bestDict.score >= 8000) {
      const d = bestDict.item;
      topWord = d.w;
      topReading = d.r || hintReading || '';
      topCategory = d.l ? `JLPT ${d.l}` : '辞書';
      topMeaningText = formatDictMeaning(d);
      topCardForSave = {
        id: `dict_${d.w}_${d.r || ''}`,
        word: d.w,
        reading: topReading,
        category: topCategory,
        meaning: {
          en: (d.m || []).join(', ') || '—',
          zh_TW: (d.zh || d.m || []).join(', ') || '—',
          zh_CN: (d.zh || d.m || []).join(', ') || '—',
          ko: (d.m || []).join(', ') || '—',
          fr: (d.fr || d.m || []).join(', ') || '—'
        }
      };
    } else if (bestCurriculum) {
      // 関連する単語としてカリキュラムの語彙がトップ
      const c = bestCurriculum.card;
      topWord = c.word;
      topReading = c.reading || hintReading || '';
      topCategory = c.category || '授業で習った言葉';
      topMeaningText = getBilingualMeaning(c.meaning, currentLang);
      topCardForSave = c;
      isTopFromRelated = true;
    } else if (bestDict) {
      // 関連する単語として辞書の最重要語（例: 「待」→「待つ」N5）がトップ
      const d = bestDict.item;
      topWord = d.w;
      topReading = d.r || hintReading || '';
      topCategory = d.l ? `JLPT ${d.l}` : '辞書';
      topMeaningText = formatDictMeaning(d);
      topCardForSave = {
        id: `dict_${d.w}_${d.r || ''}`,
        word: d.w,
        reading: topReading,
        category: topCategory,
        meaning: {
          en: (d.m || []).join(', ') || '—',
          zh_TW: (d.zh || d.m || []).join(', ') || '—',
          zh_CN: (d.zh || d.m || []).join(', ') || '—',
          ko: (d.m || []).join(', ') || '—',
          fr: (d.fr || d.m || []).join(', ') || '—'
        }
      };
      isTopFromRelated = true;
    } else {
      topMeaningText = '日本語表現・単語';
      topCardForSave = {
        id: `custom_dict_${cleanWord}_${Date.now()}`,
        word: cleanWord,
        reading: topReading || cleanWord,
        category: '例文から保存',
        meaning: {
          en: cleanWord,
          zh_TW: cleanWord,
          zh_CN: cleanWord,
          ko: cleanWord,
          fr: cleanWord
        }
      };
    }

    const isAlreadySaved = mylistSet.has(topCardForSave.id) || mylistSet.has(topWord);

    // --- 5. 関連単語リスト（2番目以降のヒット）の構築 ---
    const relatedList = [];
    const usedWordKeys = new Set([topWord]);

    // カリキュラム内の関連語を優先追加
    matchedCurriculumCards.forEach(mc => {
      if (!usedWordKeys.has(mc.card.word)) {
        usedWordKeys.add(mc.card.word);
        relatedList.push({
          word: mc.card.word,
          reading: mc.card.reading || '',
          category: mc.card.category || '授業で習った言葉',
          badgeClass: 'bg-rose-100 text-rose-800',
          meaning: getBilingualMeaning(mc.card.meaning, currentLang),
          cardObj: mc.card
        });
      }
    });

    // 辞書内の関連語を追加
    dictScoredMatches.forEach(dm => {
      if (!usedWordKeys.has(dm.item.w) && relatedList.length < 12) {
        usedWordKeys.add(dm.item.w);
        const d = dm.item;
        const meaning = formatDictMeaning(d);
        const cardObj = {
          id: `dict_${d.w}_${d.r || ''}`,
          word: d.w,
          reading: d.r || '',
          category: d.l ? `JLPT ${d.l}` : '辞書',
          meaning: {
            en: (d.m || []).join(', ') || '—',
            zh_TW: (d.zh || d.m || []).join(', ') || '—',
            zh_CN: (d.zh || d.m || []).join(', ') || '—',
            ko: (d.m || []).join(', ') || '—',
            fr: (d.fr || d.m || []).join(', ') || '—'
          }
        };
        relatedList.push({
          word: d.w,
          reading: d.r || '',
          category: d.l ? `JLPT ${d.l}` : '辞書',
          badgeClass: d.l ? 'bg-sky-100 text-sky-800' : 'bg-slate-100 text-slate-700',
          meaning: meaning,
          cardObj: cardObj
        });
      }
    });

    // --- 6. モーダルHTML生成 ---
    let modalHtml = `
      <!-- 選択文字列インジケーター (漢字1文字や部分選択の場合にわかりやすく案内) -->
      ${isTopFromRelated || topWord !== cleanWord ? `
        <div class="px-3 py-1.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs flex items-center justify-between">
          <span>選択: <strong class="text-amber-900">「${escapeHtml(cleanWord)}」</strong> を使った最も関連性の高い単語:</span>
          <span class="text-[10px] font-bold bg-amber-200/80 px-2 py-0.5 rounded-md">関連検索</span>
        </div>
      ` : ''}

      <!-- メインヒット単語カード -->
      <div class="p-4 rounded-2xl bg-sky-50 border border-sky-200 space-y-3">
        <div class="flex items-baseline justify-between flex-wrap gap-2">
          <div>
            <span class="text-[10px] font-extrabold bg-sky-600 text-white px-2 py-0.5 rounded-full mr-1.5">${topCategory}</span>
            <span class="text-2xl font-black text-slate-900">${escapeHtml(topWord)}</span>
            ${topReading && topReading !== topWord ? `<span class="text-sm font-bold text-sky-700 ml-1.5">【${escapeHtml(topReading)}】</span>` : ''}
          </div>
          <div class="flex items-center space-x-1.5">
            <button id="btnModalSpeakWord" class="p-2 rounded-xl bg-white border border-sky-200 text-sky-700 hover:bg-sky-100 transition shadow-2xs font-bold text-xs flex items-center space-x-1" title="発音を聞く">
              <span>🔊</span>
              <span>発音</span>
            </button>
            <button id="btnModalSaveWord" class="px-3 py-1.5 rounded-xl font-bold text-xs transition shadow-2xs flex items-center space-x-1 text-white ${isAlreadySaved ? 'bg-emerald-700 hover:bg-emerald-800' : 'bg-emerald-600 hover:bg-emerald-500'}" title="マイリストに保存">
              <span>${isAlreadySaved ? '✅' : '🔖'}</span>
              <span>${isAlreadySaved ? 'マイリスト保存中' : 'マイリストに追加'}</span>
            </button>
          </div>
        </div>

        <div class="pt-2 border-t border-sky-200/60 text-xs sm:text-sm text-slate-700 leading-relaxed">
          <strong class="text-slate-900 block mb-0.5">意味・訳:</strong>
          <p class="font-bold text-slate-800">${escapeHtml(topMeaningText)}</p>
        </div>
      </div>
    `;

    // 関連単語リストのレンダリング
    if (relatedList.length > 0) {
      modalHtml += `
        <div class="space-y-2 pt-1">
          <h4 class="text-xs font-bold text-slate-600 flex items-center justify-between">
            <span class="flex items-center space-x-1">
              <span>📚</span>
              <span>「${escapeHtml(cleanWord)}」を含む関連単語 (${relatedList.length}件)</span>
            </span>
            <span class="text-[10px] text-slate-400 font-normal">タップで詳細表示</span>
          </h4>
          <div class="space-y-1.5 max-h-[42vh] overflow-y-auto pr-1">
            ${relatedList.map((rel, idx) => {
              const isRelSaved = mylistSet.has(rel.cardObj.id) || mylistSet.has(rel.word);
              return `
                <div class="rel-word-item p-2.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between text-xs hover:bg-blue-50/50 hover:border-sky-300 transition cursor-pointer" data-idx="${idx}">
                  <div class="flex items-baseline space-x-1.5 truncate pr-2">
                    <span class="font-bold text-slate-900">${escapeHtml(rel.word)}</span>
                    ${rel.reading ? `<span class="text-[11px] text-slate-400">（${escapeHtml(rel.reading)}）</span>` : ''}
                    <span class="text-[9px] px-1.5 py-0.2 rounded font-bold ${rel.badgeClass} shrink-0">${rel.category}</span>
                    <span class="text-[11px] text-slate-600 ml-1 truncate">${escapeHtml(rel.meaning)}</span>
                  </div>
                  <div class="flex items-center space-x-1 shrink-0">
                    <button class="btn-sub-speak-word p-1 text-slate-400 hover:text-sky-600 rounded transition" title="発音を聞く" data-word="${escapeHtml(rel.word)}">
                      <span>🔊</span>
                    </button>
                    <button class="btn-sub-save-word px-2 py-1 rounded-lg border font-bold text-[10px] transition ${isRelSaved ? 'bg-emerald-100 border-emerald-400 text-emerald-800' : 'bg-white border-emerald-300 text-emerald-700 hover:bg-emerald-50'}"
                      data-idx="${idx}">
                      ${isRelSaved ? '✓ 保存中' : '🔖 保存'}
                    </button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }

    content.innerHTML = modalHtml;

    // --- 7. イベントリスナーの接続 ---
    const btnSpeak = content.querySelector('#btnModalSpeakWord');
    if (btnSpeak) {
      btnSpeak.addEventListener('click', () => {
        toggleJapaneseSpeech(topWord);
      });
    }

    const btnSave = content.querySelector('#btnModalSaveWord');
    if (btnSave) {
      btnSave.addEventListener('click', () => {
        promptFolderSelectAndAdd(topCardForSave, () => {
          updateMylistBadge();
          renderCurrentCard();
          openDictLookupModal(queryWord, hintReading); // モーダル内のボタン表示を更新
        });
      });
    }

    // 関連単語クリックでその単語の詳細をモーダルで開く
    content.querySelectorAll('.rel-word-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const idx = parseInt(item.getAttribute('data-idx'), 10);
        const targetRel = relatedList[idx];
        if (targetRel) {
          openDictLookupModal(targetRel.word, targetRel.reading);
        }
      });
    });

    // 関連単語の発音ボタン
    content.querySelectorAll('.btn-sub-speak-word').forEach(spkBtn => {
      spkBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sw = spkBtn.getAttribute('data-word');
        if (sw) toggleJapaneseSpeech(sw);
      });
    });

    // 関連単語の保存ボタン
    content.querySelectorAll('.btn-sub-save-word').forEach(subBtn => {
      subBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(subBtn.getAttribute('data-idx'), 10);
        const targetRel = relatedList[idx];
        if (!targetRel) return;

        promptFolderSelectAndAdd(targetRel.cardObj, () => {
          updateMylistBadge();
          renderCurrentCard();
          openDictLookupModal(queryWord, hintReading);
        });
      });
    });

    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  // ==========================================
  // --- 使い方ガイド (Help Guide) スライド式コントローラー ---
  // ==========================================
  let currentHelpGuideSlideIndex = 0;

  const HELP_GUIDE_SLIDES = [
    {
      id: 'search',
      badge: { ja: 'ステップ 1 / 検索', en: 'Step 1 / Search' },
      title: { ja: '🔍 検索窓で探してマイリストへ追加', en: 'Search & Add to My List' },
      subtitle: {
        ja: '上部の検索バーに日本語（漢字・ひらがな・ローマ字）や母国語を入力するだけで、瞬時に目的の単語が見つかります。',
        en: 'Type Japanese (kanji, hiragana, romaji) or your native language in the top search bar to find words instantly.'
      },
      diagramHtml: `
        <div class="rounded-2xl bg-gradient-to-br from-slate-50 to-sky-50 border border-sky-100 p-3 shadow-inner space-y-2.5">
          <!-- 検索バーのイラスト風UI -->
          <div class="flex items-center space-x-2 bg-deepNavy text-white px-3 py-2 rounded-full shadow-sm">
            <span class="text-xs">🔍</span>
            <span class="text-[11px] font-mono text-white/90 bg-white/20 px-2 py-0.5 rounded-full font-bold">ねこ / cat / 猫</span>
            <span class="text-[10px] text-white/60 ml-auto">母国語・日本語OK</span>
          </div>
          <!-- 検索結果のカード例 -->
          <div class="bg-white rounded-xl p-2.5 border border-slate-200 shadow-2xs flex items-center justify-between">
            <div>
              <div class="flex items-baseline space-x-1.5">
                <span class="text-sm font-black text-slate-800">猫</span>
                <span class="text-[11px] font-bold text-deepNavy">（ねこ）</span>
              </div>
              <p class="text-[10px] text-slate-500 font-medium">cat / 猫咪 / 고양이</p>
            </div>
            <!-- アクションボタン -->
            <div class="flex items-center space-x-1">
              <span class="text-[10px] font-bold px-2 py-1 rounded-lg bg-amber-50 border border-amber-300 text-amber-700 flex items-center space-x-0.5 shadow-2xs">
                <span>⭐</span>
                <span>マイリスト追加</span>
              </span>
            </div>
          </div>
        </div>
      `,
      tips: {
        ja: '💡 漢字一文字や「〜の時」のような語句でも、関連する単語を自動的に探してくれます！',
        en: '💡 Search works with single kanji, phrases, or grammar patterns too!'
      }
    },
    {
      id: 'swipe_marking',
      badge: { ja: 'ステップ 2 / 復習管理', en: 'Step 2 / Review & Learn' },
      title: { ja: '🔄 「覚えた！」と「もう一回」に仕分け', en: 'Sort into "Learned" & "Review"' },
      subtitle: {
        ja: 'カードをめくって学習したら、理解度に合わせて仕分け。スマホ版は左右のスワイプ操作で直感的に仕分けできます！',
        en: 'After flipping the card, sort it. On smartphones, easily swipe left or right!'
      },
      diagramHtml: `
        <div class="rounded-2xl bg-gradient-to-br from-rose-50/50 via-white to-emerald-50/50 border border-slate-200 p-3 shadow-inner space-y-3">
          <!-- スマホスワイプジェスチャーの図解 -->
          <div class="relative bg-white rounded-2xl border-2 border-dashed border-slate-300 p-3 text-center shadow-xs overflow-hidden">
            <div class="text-[11px] font-extrabold text-slate-400 mb-1">📱 スマホ版スワイプ操作</div>
            <div class="flex items-center justify-between px-2">
              <!-- 左スワイプ -->
              <div class="flex flex-col items-center">
                <span class="text-lg">👈</span>
                <span class="text-[10px] font-black px-2 py-0.5 rounded-full bg-rose-100 text-coralPink border border-rose-200 mt-0.5">左: もう一回！</span>
              </div>
              <!-- 中央カード -->
              <div class="w-20 py-2 rounded-xl bg-deepNavy text-white text-[11px] font-bold shadow-md">
                単語カード
              </div>
              <!-- 右スワイプ -->
              <div class="flex flex-col items-center">
                <span class="text-lg">👉</span>
                <span class="text-[10px] font-black px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200 mt-0.5">右: 覚えた！</span>
              </div>
            </div>
          </div>
          <!-- PC版ボタンの図解 -->
          <div class="flex items-center justify-center space-x-3 text-xs">
            <span class="px-3 py-1 rounded-xl bg-white border border-rose-200 text-coralPink font-extrabold shadow-2xs">
              🔁 もう一度！
            </span>
            <span class="text-[10px] text-slate-400 font-bold">PC版はボタンをクリック</span>
            <span class="px-3 py-1 rounded-xl bg-deepNavy text-white font-extrabold shadow-2xs">
              ✨ 覚えた！
            </span>
          </div>
        </div>
      `,
      tips: {
        ja: '💡 仕分けた単語はマイリストの『覚えた！』『もう一度！』フォルダに自動保存されます。',
        en: '💡 Words are automatically saved to your "Learned" and "Review" folders.'
      }
    },
    {
      id: 'custom_folders',
      badge: { ja: 'ステップ 3 / 整理', en: 'Step 3 / Folders' },
      title: { ja: '📁 フォルダを自由に作成して整理', en: 'Create Custom Folders' },
      subtitle: {
        ja: '「旅行用」「苦手な漢字」「第5課復習」など、自分で好きなフォルダを作って単語を自由にまとめられます。',
        en: 'Organize words into your own custom folders like "Travel", "Tricky Kanji", or "Lesson 5".'
      },
      diagramHtml: `
        <div class="rounded-2xl bg-gradient-to-br from-amber-50/60 to-orange-50/60 border border-amber-200 p-3 shadow-inner space-y-2">
          <!-- フォルダ作成ヘッダー -->
          <div class="flex items-center justify-between bg-white px-3 py-1.5 rounded-xl border border-amber-200 shadow-2xs">
            <span class="text-xs font-bold text-amber-900 flex items-center space-x-1">
              <span>📁</span>
              <span>マイリストのフォルダ</span>
            </span>
            <span class="text-[10px] font-black px-2 py-0.5 rounded-full bg-deepNavy text-white shadow-2xs">
              ＋ フォルダ作成
            </span>
          </div>
          <!-- フォルダタグ一覧例 -->
          <div class="grid grid-cols-3 gap-1.5 pt-1">
            <div class="bg-white p-2 rounded-xl border border-slate-200 text-center shadow-2xs">
              <span class="text-sm block">🌸</span>
              <span class="text-[10px] font-bold text-slate-700">日常会話</span>
            </div>
            <div class="bg-white p-2 rounded-xl border border-slate-200 text-center shadow-2xs">
              <span class="text-sm block">✈️</span>
              <span class="text-[10px] font-bold text-slate-700">旅行・買い物</span>
            </div>
            <div class="bg-white p-2 rounded-xl border border-slate-200 text-center shadow-2xs">
              <span class="text-sm block">📝</span>
              <span class="text-[10px] font-bold text-slate-700">苦手な動詞</span>
            </div>
          </div>
        </div>
      `,
      tips: {
        ja: '💡 単語の保存時に保存先フォルダを選べるほか、フォルダごとの集中テストもできます！',
        en: '💡 Choose which folder to save each word to, and take quizzes by folder!'
      }
    },
    {
      id: 'auto_audio',
      badge: { ja: 'ステップ 4 / 音声機能', en: 'Step 4 / Audio & Voice' },
      title: { ja: '🔊 音声自動再生で耳から覚える', en: 'Auto Audio Playback' },
      subtitle: {
        ja: '画面上部の「自動再生」をONにすると、カードを表示した時やめくった時に単語と例文が自動で流れます。',
        en: 'Turn on "Auto Audio" in the top bar to automatically hear words and example sentences.'
      },
      diagramHtml: `
        <div class="rounded-2xl bg-gradient-to-br from-rose-50/60 to-sky-50/60 border border-softBorder p-3 shadow-inner space-y-2.5">
          <!-- スイッチUIの図解 -->
          <div class="flex items-center justify-between bg-deepNavy text-white px-3 py-2 rounded-xl shadow-xs">
            <div class="flex items-center space-x-1.5">
              <span class="text-xs">🔊</span>
              <span class="text-xs font-bold">自動再生スイッチ</span>
            </div>
            <div class="flex items-center space-x-1 bg-coralPink px-2.5 py-0.5 rounded-full border border-white text-[10px] font-black text-white shadow-2xs">
              <span>ON</span>
              <span class="w-3 h-3 rounded-full bg-white ml-1 inline-block"></span>
            </div>
          </div>
          <!-- 音声ストップ機能の図解 -->
          <div class="bg-white rounded-xl p-2.5 border border-slate-200 shadow-2xs space-y-1">
            <div class="flex items-center space-x-1.5 text-[11px] font-bold text-slate-700">
              <span class="w-5 h-5 rounded-full bg-coralPink text-white flex items-center justify-center text-[10px] shadow-2xs">🔊</span>
              <span>音声ボタンをもう一度押すと停止（Stop）</span>
            </div>
            <p class="text-[10px] text-slate-500 leading-relaxed pl-6">
              再生中に音声ボタンをもう一度タップすると、いつでもすぐにストップできます。
            </p>
          </div>
        </div>
      `,
      tips: {
        ja: '💡 例文も自然な日本語イントネーションで発音されます。シャドーイングの練習に最適です！',
        en: '💡 Plays natural Japanese intonation, perfect for shadowing practice!'
      }
    },
    {
      id: 'furigana',
      badge: { ja: 'ステップ 5 / 漢字練習', en: 'Step 5 / Furigana OFF' },
      title: { ja: '✍️ ふりがなOFFで漢字テスト', en: 'Practice Reading Kanji' },
      subtitle: {
        ja: '「ふりがな」をOFFに切り替えると、漢字の上の読みが隠れるので、漢字を自力で読めるか確認・特訓できます。',
        en: 'Turn Furigana OFF to hide hiragana readings above kanji and test your memory.'
      },
      diagramHtml: `
        <div class="rounded-2xl bg-gradient-to-br from-slate-100 to-slate-200 border border-slate-300 p-3 shadow-inner space-y-2.5">
          <!-- スイッチUI -->
          <div class="flex items-center justify-between bg-deepNavy text-white px-3 py-2 rounded-xl shadow-xs">
            <div class="flex items-center space-x-1.5">
              <span class="text-xs">あ/A</span>
              <span class="text-xs font-bold">ふりがなスイッチ</span>
            </div>
            <div class="flex items-center space-x-1 bg-slate-600 px-2.5 py-0.5 rounded-full border border-white text-[10px] font-black text-white shadow-2xs">
              <span class="w-3 h-3 rounded-full bg-white mr-1 inline-block"></span>
              <span>OFF</span>
            </div>
          </div>
          <!-- 比較イラスト -->
          <div class="grid grid-cols-2 gap-2 text-center text-xs">
            <div class="bg-white p-2.5 rounded-xl border border-slate-200 shadow-2xs">
              <span class="text-[10px] font-bold text-slate-400 block mb-1">【ON】 読みつき</span>
              <ruby class="text-sm font-bold text-slate-800">朝ご飯<rt class="text-deepNavy">あさごはん</rt></ruby>
            </div>
            <div class="bg-white p-2.5 rounded-xl border-2 border-coralPink shadow-2xs">
              <span class="text-[10px] font-bold text-coralPink block mb-1">【OFF】 漢字チャレンジ</span>
              <span class="text-sm font-black text-slate-900">朝ご飯</span>
            </div>
          </div>
        </div>
      `,
      tips: {
        ja: '💡 辞書を開いたときは、OFF時でも常に正確なふりがなが表示されるので安心です！',
        en: '💡 Furigana is always available inside the dictionary lookup modal!'
      }
    },
    {
      id: 'dict_lookup',
      badge: { ja: 'ステップ 6 / 辞書検索', en: 'Step 6 / Built-in Dictionary' },
      title: { ja: '📖 わからない言葉はなぞって辞書へ', en: 'Lookup & Save from Sentences' },
      subtitle: {
        ja: '例文の中で知らない単語や漢字があったら、指やマウスで選択（なぞる）だけですぐにポップアップが出現！',
        en: 'Highlight any unknown word or kanji in the example sentence to lookup and save instantly!'
      },
      diagramHtml: `
        <div class="rounded-2xl bg-gradient-to-br from-sky-50 to-indigo-50 border border-sky-200 p-3 shadow-inner space-y-2.5">
          <!-- 選択ツールバーのイラスト風再現 -->
          <div class="bg-white rounded-xl p-2.5 border border-slate-200 shadow-2xs">
            <p class="text-[11px] text-slate-700 leading-relaxed">
              明日、友達と<span class="bg-sky-200 text-sky-900 font-bold px-1 rounded">図書館</span>へ行きます。
            </p>
          </div>
          <!-- ツールバーの吹き出し -->
          <div class="flex items-center justify-center space-x-1.5 bg-slate-900 text-white px-3 py-1.5 rounded-xl shadow-lg border border-slate-700 text-xs">
            <span class="font-extrabold text-sky-400 text-[11px]">図書館</span>
            <span class="px-2 py-0.5 rounded-lg bg-sky-600 font-bold text-[10px] flex items-center space-x-0.5 shadow-2xs">
              <span>🔍</span>
              <span>辞書で調べる</span>
            </span>
            <span class="px-2 py-0.5 rounded-lg bg-emerald-600 font-bold text-[10px] flex items-center space-x-0.5 shadow-2xs">
              <span>🔖</span>
              <span>保存</span>
            </span>
          </div>
        </div>
      `,
      tips: {
        ja: '💡 辞書モーダルでは意味・例文・関連語を一度に確認でき、その場でマイリストへワンタップ保存できます！',
        en: '💡 Check meanings, examples, and related words, and add them to My List in one tap!'
      }
    }
  ];

  function renderHelpGuideSlide(index) {
    if (index < 0) index = 0;
    if (index >= HELP_GUIDE_SLIDES.length) index = HELP_GUIDE_SLIDES.length - 1;
    currentHelpGuideSlideIndex = index;

    const slide = HELP_GUIDE_SLIDES[currentHelpGuideSlideIndex];
    const isJa = (currentLang === 'ja');
    const total = HELP_GUIDE_SLIDES.length;

    // ステップバッジ更新
    const stepBadge = document.getElementById('helpGuideStepBadge');
    if (stepBadge) {
      stepBadge.textContent = `${currentHelpGuideSlideIndex + 1} / ${total}`;
    }

    // スライド本体更新
    const container = document.getElementById('helpGuideSlideContainer');
    if (container) {
      const badgeText = isJa ? slide.badge.ja : slide.badge.en;
      const titleText = isJa ? slide.title.ja : slide.title.en;
      const subtitleText = isJa ? slide.subtitle.ja : slide.subtitle.en;
      const tipText = isJa ? slide.tips.ja : slide.tips.en;

      container.innerHTML = `
        <div class="space-y-3.5">
          <!-- 上部バッジ & タイトル -->
          <div>
            <span class="inline-block px-2.5 py-0.5 rounded-full bg-deepNavy/10 text-deepNavy text-[11px] font-extrabold mb-1">
              ${badgeText}
            </span>
            <h3 class="text-base sm:text-lg font-black text-slate-800 leading-snug">
              ${titleText}
            </h3>
            <p class="text-xs text-slate-600 leading-relaxed mt-1">
              ${subtitleText}
            </p>
          </div>

          <!-- イラスト・図解カード -->
          <div>
            ${slide.diagramHtml}
          </div>

          <!-- ヒント・アドバイス -->
          <div class="p-2.5 rounded-xl bg-amber-50/70 border border-amber-200/80 text-[11px] text-amber-900 font-medium leading-relaxed">
            ${tipText}
          </div>
        </div>
      `;
    }

    // ドット インジケーター更新
    const dotsContainer = document.getElementById('helpGuideDotsContainer');
    if (dotsContainer) {
      dotsContainer.innerHTML = HELP_GUIDE_SLIDES.map((_, i) => {
        const isActive = (i === currentHelpGuideSlideIndex);
        return `
          <button onclick="goToHelpGuideSlide(${i})" class="w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full transition-all duration-200 ${isActive ? 'bg-deepNavy w-5 sm:w-6' : 'bg-slate-300 hover:bg-slate-400'}" title="Slide ${i + 1}"></button>
        `;
      }).join('');
    }

    // ナビゲーションボタン更新
    const btnPrev = document.getElementById('btnHelpGuidePrev');
    const btnNext = document.getElementById('btnHelpGuideNext');
    const prevText = document.getElementById('helpGuidePrevText');
    const nextText = document.getElementById('helpGuideNextText');

    if (btnPrev) {
      btnPrev.disabled = (currentHelpGuideSlideIndex === 0);
    }
    if (prevText) {
      prevText.textContent = isJa ? '前へ' : 'Prev';
    }

    if (btnNext && nextText) {
      const isLast = (currentHelpGuideSlideIndex === total - 1);
      if (isLast) {
        nextText.textContent = isJa ? '完了 (閉じる)' : 'Done (Close)';
        btnNext.className = 'px-4 py-1.5 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold transition text-xs flex items-center space-x-1 shadow-xs active:scale-95';
      } else {
        nextText.textContent = isJa ? '次へ' : 'Next';
        btnNext.className = 'px-4 py-1.5 rounded-full bg-deepNavy hover:bg-slate-800 text-white font-bold transition text-xs flex items-center space-x-1 shadow-xs active:scale-95';
      }
    }

    // Lucide アイコン再初期化
    if (window.lucide) {
      const modalEl = document.getElementById('helpGuideModal');
      if (modalEl) lucide.createIcons({ root: modalEl });
    }
  }

  function goToHelpGuideSlide(index) {
    renderHelpGuideSlide(index);
  }

  function nextHelpGuideSlide() {
    if (currentHelpGuideSlideIndex < HELP_GUIDE_SLIDES.length - 1) {
      renderHelpGuideSlide(currentHelpGuideSlideIndex + 1);
    } else {
      closeHelpGuideModal();
    }
  }

  function prevHelpGuideSlide() {
    if (currentHelpGuideSlideIndex > 0) {
      renderHelpGuideSlide(currentHelpGuideSlideIndex - 1);
    }
  }

  function openHelpGuideModal() {
    const modal = document.getElementById('helpGuideModal');
    if (modal) {
      currentHelpGuideSlideIndex = 0;
      renderHelpGuideSlide(0);
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }
  }

  function closeHelpGuideModal() {
    const modal = document.getElementById('helpGuideModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  // グローバル露出（インラインイベント等からの呼出用）
  window.closeDictPopupModal = closeDictPopupModal;
  window.openDictLookupModal = openDictLookupModal;
  window.openHelpGuideModal = openHelpGuideModal;
  window.closeHelpGuideModal = closeHelpGuideModal;
  window.goToHelpGuideSlide = goToHelpGuideSlide;
  window.nextHelpGuideSlide = nextHelpGuideSlide;
  window.prevHelpGuideSlide = prevHelpGuideSlide;

  // --- App Startup ---
  function startup() {
    initData();
    setupListeners();
    // ★ 例文のテキスト選択ツールバー（辞書で調べる / マイリスト保存）初期化
    if (typeof initExampleSelectionToolbar === 'function') {
      initExampleSelectionToolbar();
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
      };
    }
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', startup);
  } else {
    startup();
  }

})();
