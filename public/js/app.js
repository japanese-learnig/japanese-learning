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

  // --- Quiz State ---
  let quizPool = [];
  let quizIndex = 0;
  let quizCurrentQuestion = null;
  let quizScore = 0;

  // --- TTS Speech Engine ---
  function cleanJapaneseForSpeech(text) {
    if (!text) return '';
    let s = String(text);
    // 1. Remove <rt>...</rt> and <rp>...</rp> completely so furigana readings are not voiced twice
    s = s.replace(/<rt[^>]*>[\s\S]*?<\/rt>/gi, '');
    s = s.replace(/<rp[^>]*>[\s\S]*?<\/rp>/gi, '');
    // 2. Remove any remaining HTML tags (e.g. <ruby>, <br>, etc.)
    s = s.replace(/<[^>]+>/g, ' ');
    // 3. Remove parentheses furigana readings: （しんごう） or (しんごう)
    s = s.replace(/[（\(][\u3040-\u309F\u30A0-\u30FF・ー\s]+[）\)]/g, '');
    // 4. Clean extra spaces
    return s.replace(/\s+/g, ' ').trim();
  }

  function speakJapanese(text) {
    if (!('speechSynthesis' in window)) {
      showToast('お使いのブラウザは音声再生に対応していません');
      return;
    }
    window.speechSynthesis.cancel(); // Stop any pending speech
    const cleanText = cleanJapaneseForSpeech(text);
    if (!cleanText) return;

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

    window.speechSynthesis.speak(utterance);
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
    const backRelatedLabel = document.getElementById('backRelatedLabel');
    if (backRelatedLabel) backRelatedLabel.textContent = isJa ? '関連語・活用形' : 'Related / Conjugations';
    const backFlipPrompt = document.getElementById('backFlipPrompt');
    if (backFlipPrompt) backFlipPrompt.textContent = isJa ? 'タップして表面に戻る' : 'Tap to flip back';

    // 8. Flashcard Bottom Navigation
    const btnPrevLabel = document.getElementById('btnPrevLabel');
    if (btnPrevLabel) btnPrevLabel.textContent = isJa ? '前へ' : 'Prev';
    const btnMarkKnownLabel = document.getElementById('btnMarkKnownLabel');
    if (btnMarkKnownLabel) btnMarkKnownLabel.textContent = isJa ? '覚えた' : 'Learned';
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
      if (lang === 'ja') mylistHeaderTitle.textContent = 'マイリスト（学習・復習）';
      else if (lang === 'zh_TW' || lang === 'zh_HK') mylistHeaderTitle.textContent = '我的清單（複習與練習）';
      else if (lang === 'zh_CN') mylistHeaderTitle.textContent = '我的清单（复习与练习）';
      else if (lang === 'ko') mylistHeaderTitle.textContent = '마이 리스트 (복습 및 학습)';
      else if (lang === 'fr') mylistHeaderTitle.textContent = 'Ma liste (Révision & Pratique)';
      else mylistHeaderTitle.textContent = 'My List (Review & Study)';
    }
    const mylistHeaderSub = document.getElementById('mylistHeaderSub');
    if (mylistHeaderSub) {
      if (lang === 'ja') mylistHeaderSub.textContent = '保存した単語をカスタムフォルダに整理';
      else if (lang === 'zh_TW' || lang === 'zh_HK') mylistHeaderSub.textContent = '將收藏的單字整理至自訂資料夾';
      else if (lang === 'zh_CN') mylistHeaderSub.textContent = '将收藏的单词整理至自定义文件夹';
      else if (lang === 'ko') mylistHeaderSub.textContent = '저장한 단어를 폴더별로 정리';
      else if (lang === 'fr') mylistHeaderSub.textContent = 'Organisez vos mots dans des dossiers';
      else mylistHeaderSub.textContent = 'Organize starred words into custom folders';
    }
    const btnCreateMylistLabel = document.getElementById('btnCreateMylistFolderLabel');
    if (btnCreateMylistLabel) {
      if (lang === 'ja') btnCreateMylistLabel.textContent = '新規フォルダ';
      else if (lang === 'zh_TW' || lang === 'zh_HK') btnCreateMylistLabel.textContent = '新增資料夾';
      else if (lang === 'zh_CN') btnCreateMylistLabel.textContent = '新建文件夹';
      else if (lang === 'ko') btnCreateMylistLabel.textContent = '새 폴더';
      else if (lang === 'fr') btnCreateMylistLabel.textContent = 'Nouveau dossier';
      else btnCreateMylistLabel.textContent = 'New Folder';
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

    // Update student badge in top header
    const headerStudentBadge = document.getElementById('headerStudentBadge');
    if (headerStudentBadge) {
      if (currentStudent) {
        headerStudentBadge.textContent = isJa ? `生徒: ${currentStudent.name}` : `Student: ${currentStudent.name}`;
      } else {
        headerStudentBadge.textContent = isJa ? '生徒: ゲスト' : 'Student: Guest';
      }
    }
  }

  // --- Data Loading & Persistence ---
  // --- Data Loading & Persistence ---
  function initData() {
    // Master data version check to ensure newly added cards & furigana updates are immediately visible
    const CURRENT_DATA_VERSION = 'v29_updated_student_passcodes';
    const savedVersion = localStorage.getItem('haku_vocab_version');

    const seedCards = window.INITIAL_VOCAB_DATA || [];
    const classCards = window.CLASS_VOCAB_DATA || [];
    const combinedMasterCards = [...seedCards, ...classCards];

    if (savedVersion !== CURRENT_DATA_VERSION) {
      // Build lookup map for latest master definitions
      const masterCardMap = new Map();
      combinedMasterCards.forEach(c => masterCardMap.set(c.id, c));

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

      // Always reload latest INITIAL_STUDENTS master list when version updates, while preserving newly added ones
      const seedStudents = window.INITIAL_STUDENTS || [];
      const savedStudents = localStorage.getItem('haku_students');
      if (savedStudents) {
        try {
          const parsed = JSON.parse(savedStudents);
          const masterIds = new Set(seedStudents.map(s => s.id));
          const customExtra = parsed.filter(s => !masterIds.has(s.id) && s.id !== 'student_1' && s.id !== 'student_2' && s.id !== 'student_3' && s.id !== 'student_4' && s.id !== 'student_5' && s.id !== 'student_6');
          students = [...seedStudents, ...customExtra];
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
        }

        localStorage.setItem(key, JSON.stringify(Array.from(new Set(filteredSet))));
        localStorage.setItem(mapKey, JSON.stringify(stMap));
      });

      localStorage.setItem('haku_vocab_version', CURRENT_DATA_VERSION);
    } else {
      const savedVocab = localStorage.getItem('haku_vocab_data');
      if (savedVocab) {
        try {
          vocabList = JSON.parse(savedVocab);
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

      // Folder Item Container
      const folderWrapper = document.createElement('div');
      folderWrapper.className = 'border border-softBorder rounded-2xl bg-white shadow-2xs overflow-hidden transition-all';

      // Folder Header
      const headerDiv = document.createElement('div');
      headerDiv.className = 'px-3 py-2.5 bg-slate-50/80 hover:bg-lightBlueBg/40 cursor-pointer flex items-center justify-between transition select-none';
      headerDiv.innerHTML = `
        <div class="flex items-center space-x-2">
          <i data-lucide="${isExpanded ? 'folder-open' : 'folder'}" class="w-4 h-4 text-deepNavy"></i>
          <div>
            <span class="text-xs font-bold text-darkNavyText">${fc.title}</span>
            <span class="text-[10px] text-slate-400 font-medium ml-1">(${folderCards.length}語)</span>
          </div>
        </div>
        <div class="flex items-center space-x-1">
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
          const secTitle = (catalogItem && catalogItem.title) || sectionsMap[secNum] || `${secNum}. 単元${secNum}`;
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
              <span class="truncate text-[11px]">${secTitle}</span>
            </div>
            <div class="flex items-center space-x-1 shrink-0">
              <span class="text-[9px] px-1.5 py-0.2 rounded-full font-bold ${isCurrentActive ? 'bg-deepNavy text-white' : 'bg-slate-100 text-slate-500'}">${count}語</span>
              <i data-lucide="chevron-right" class="w-3 h-3 text-slate-300 group-hover:text-deepNavy transition"></i>
            </div>
          `;

          unitItem.addEventListener('click', () => {
            currentFolder = fc.id;
            startStudyingSection(secNum, secTitle);
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
  function renderUnifiedSearchResults(rawQuery) {
    const sidebarContainer = document.getElementById('sidebarFolderListContainer');
    const dropdownContainer = document.getElementById('searchDropdownContainer');

    const hiraQuery = toHiragana(rawQuery);

    // Search Curriculum Words
    let curFiltered = vocabList.filter(c => {
      const w = (c.word || '').toLowerCase();
      const r = (c.reading || '').toLowerCase();
      const rHira = toHiragana(r);
      const wHira = toHiragana(w);
      const allMeanings = Object.values(c.meaning || {}).join(' ').toLowerCase();
      const exJa = (c.example && c.example.ja ? c.example.ja.replace(/<[^>]+>/g, '') : '').toLowerCase();
      const exTrans = Object.values(c.example || {}).join(' ').toLowerCase();
      const cat = (c.category || '').toLowerCase();
      const sec = (c.section_title || '').toLowerCase();

      return (
        w.includes(rawQuery) ||
        r.includes(rawQuery) ||
        wHira.includes(hiraQuery) ||
        rHira.includes(hiraQuery) ||
        allMeanings.includes(rawQuery) ||
        exJa.includes(rawQuery) ||
        exJa.includes(hiraQuery) ||
        exTrans.includes(rawQuery) ||
        cat.includes(rawQuery) ||
        sec.includes(rawQuery)
      );
    });

    // Search Dictionary Words
    const dictSource = window.DICT_DATA || [];
    const exMap = window.DICT_EXAMPLES_MAP || {};
    const knownWords = new Set(vocabList.map(c => c.word));

    const dictMatched = dictSource.filter(entry => {
      if (knownWords.has(entry.w)) return false;
      const w = (entry.w || '').toLowerCase();
      const r = (entry.r || '').toLowerCase();
      const mList = (entry.m || []).join(' ').toLowerCase();
      const zhList = (entry.zh || []).join(' ').toLowerCase();
      const frList = (entry.fr || []).join(' ').toLowerCase();
      return (
        w.includes(rawQuery) ||
        r.includes(rawQuery) ||
        w.includes(hiraQuery) ||
        r.includes(hiraQuery) ||
        mList.includes(rawQuery) ||
        zhList.includes(rawQuery) ||
        frList.includes(rawQuery)
      );
    }).slice(0, 80).map((entry, idx) => {
      const matchedEx = exMap[entry.w] || (entry.r ? exMap[entry.r] : null);
      return {
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
    });

    const results = [...curFiltered, ...dictMatched];

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
          <div class="p-2.5 flex items-center justify-between cursor-pointer">
            <div class="flex-1 min-w-0 pr-2">
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
              <i data-lucide="${isExpanded ? 'chevron-up' : 'chevron-down'}" class="w-3.5 h-3.5 text-slate-400"></i>
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

        // Click on header text to toggle accordion
        itemCard.querySelector('.flex-1').addEventListener('click', () => {
          expandedWordId = (expandedWordId === card.id) ? null : card.id;
          renderUnifiedSearchResults(rawQuery);
        });

        const toggleChevron = itemCard.querySelector('[data-lucide="chevron-up"], [data-lucide="chevron-down"]');
        if (toggleChevron && toggleChevron.parentElement) {
          toggleChevron.parentElement.addEventListener('click', () => {
            expandedWordId = (expandedWordId === card.id) ? null : card.id;
            renderUnifiedSearchResults(rawQuery);
          });
        }

        // Voice audio buttons
        const audioWordBtn = itemCard.querySelector('.btn-audio-word');
        if (audioWordBtn) {
          audioWordBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            speakJapanese(card.word);
          });
        }
        const audioExBtn = itemCard.querySelector('.btn-audio-example');
        if (audioExBtn && card.example && card.example.ja) {
          audioExBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            speakJapanese(card.example.ja);
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
    }
  }

  // --- PC / Mobile Layout (Unified Centered Single-Column Layout) ---
  function initLayoutMode() {
    const sidebar = document.getElementById('vocabSidebar');
    const mainContainer = document.getElementById('mainContainer');

    function applyLayout() {
      if (sidebar) sidebar.classList.add('hidden');
      if (mainContainer) mainContainer.className = 'flex-1 w-full max-w-md mx-auto p-3 sm:p-4 transition-all';
    }

    applyLayout();
    window.addEventListener('resize', applyLayout);
  }

  function setStudent(student) {
    currentStudent = student;
    if (student) {
      localStorage.setItem('haku_current_student_id', student.id);
      document.getElementById('headerStudentBadge').textContent = `Student: ${student.name}`;
      // Update drawer student display
      const drawerName = document.getElementById('drawerStudentName');
      const drawerStatus = document.getElementById('drawerStudentStatus');
      const drawerBtnLogin = document.getElementById('drawerBtnLogin');
      if (drawerName) drawerName.textContent = student.name;
      if (drawerStatus) drawerStatus.textContent = 'Logged In';
      if (drawerBtnLogin) drawerBtnLogin.textContent = 'Switch / Log Out';

      // Auto-switch language based on student profile!
      currentLang = student.lang || 'en';
      const drawerLangSelect = document.getElementById('drawerLangSelect');
      if (drawerLangSelect) drawerLangSelect.value = currentLang;

      showToast(`Logged in as ${student.name}`);
    } else {
      localStorage.removeItem('haku_current_student_id');
      document.getElementById('headerStudentBadge').textContent = 'Student: Guest';
      const drawerName = document.getElementById('drawerStudentName');
      const drawerStatus = document.getElementById('drawerStudentStatus');
      const drawerBtnLogin = document.getElementById('drawerBtnLogin');
      if (drawerName) drawerName.textContent = 'Guest';
      if (drawerStatus) drawerStatus.textContent = 'Not logged in';
      if (drawerBtnLogin) drawerBtnLogin.textContent = 'Log In';
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

    // Ensure the default folder "授業で習った言葉" is always present for every student
    const CLASS_FOLDER_ID = 'folder_class_words';
    const CLASS_FOLDER_NAME = '授業で習った言葉';
    if (!mylistFolders.find(f => f.id === CLASS_FOLDER_ID || f.name === CLASS_FOLDER_NAME)) {
      mylistFolders.unshift({ id: CLASS_FOLDER_ID, name: CLASS_FOLDER_NAME });
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
    }

    updateMylistBadge();
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

  // --- Filtering & Deck Navigation System ---
  let currentFolder = 'all'; // 'folder_1', 'folder_2', 'folder_3', 'folder_4'
  let currentSection = 'all'; // 1 to 38 or 'all'
  let currentNavLevel = 'folders'; // 'folders' (level 1), 'units' (level 2), 'study' (level 3)

  const FOLDER_CONFIGS = [
    { id: 'folder_1', title: '初級 1-10', desc: '挨拶・身の回り・家族・場所・体・数字', range: [1, 10], badge: 'STAGE 1' },
    { id: 'folder_2', title: '初級 11-20', desc: '日時・数え方・動詞・食べ物・する動詞', range: [11, 20], badge: 'STAGE 2' },
    { id: 'folder_3', title: '初級 21-30', desc: '会話・形容詞・予定・天気・電車・て形', range: [21, 30], badge: 'STAGE 3' },
    { id: 'folder_4', title: '初級 31-43', desc: 'て形応用・動詞4/5・病気・ない形・可能形', range: [31, 43], badge: 'STAGE 4' }
  ];

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

      // Wrapper matching Image 2: rounded-2xl border bg-white
      const folderWrapper = document.createElement('div');
      folderWrapper.className = 'border border-softBorder rounded-2xl bg-white shadow-2xs overflow-hidden transition-all';

      // Header row: [Folder icon] [初級 1-10 (262語)] ... [Play] [Check/Test] [Chevron]
      const headerDiv = document.createElement('div');
      headerDiv.className = 'px-3.5 py-3 hover:bg-slate-50 cursor-pointer flex items-center justify-between select-none transition';
      headerDiv.innerHTML = `
        <div class="flex items-center space-x-2.5 truncate pr-2">
          <i data-lucide="${isExpanded ? 'folder-open' : 'folder'}" class="w-5 h-5 text-deepNavy shrink-0"></i>
          <span class="text-sm font-bold text-darkNavyText truncate">${fc.title}</span>
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
          const secTitle = (catalogItem && catalogItem.title) || sectionsMap[secNum] || `${secNum}. 単元${secNum}`;
          const secCards = vocabList.filter(c => c.section_num === secNum);
          const numDisplay = secNum === 0 ? '★' : `${secNum}`;

          const unitItem = document.createElement('div');
          unitItem.className = 'group flex items-center justify-between px-3 py-2 rounded-xl cursor-pointer transition text-xs bg-white border border-slate-200/80 hover:border-deepNavy hover:bg-blue-50/30';
          unitItem.innerHTML = `
            <div class="flex items-center space-x-2 truncate pr-2">
              <span class="w-5 h-5 rounded-md bg-slate-100 text-slate-700 font-bold text-[10px] flex items-center justify-center shrink-0">${numDisplay}</span>
              <span class="truncate font-semibold text-slate-800 text-xs">${secTitle}</span>
            </div>
            <div class="flex items-center space-x-1 shrink-0 text-slate-400">
              <span class="text-[10px] px-1.5 py-0.5 rounded font-medium bg-slate-100 text-slate-600">${secCards.length}語</span>
              <i data-lucide="chevron-right" class="w-3.5 h-3.5 text-slate-300 group-hover:text-deepNavy transition"></i>
            </div>
          `;

          unitItem.addEventListener('click', (e) => {
            e.stopPropagation();
            currentFolder = fc.id;
            startStudyingSection(secNum, secTitle);
          });

          unitsContainer.appendChild(unitItem);
        });

        folderWrapper.appendChild(unitsContainer);
      }

      container.appendChild(folderWrapper);
    });

    lucide.createIcons({ root: container });
  }

  function openFolderUnits(folderId) {
    currentFolder = folderId;
    currentNavLevel = 'units';

    const fc = FOLDER_CONFIGS.find(f => f.id === folderId);
    document.getElementById('currentFolderTitle').textContent = fc ? `${fc.title}` : '単元一覧';

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
      const secTitle = (catalogItem && catalogItem.title) || sectionsMap[secNum] || `${secNum}. 単元${secNum}`;
      const secCards = vocabList.filter(c => c.section_num === secNum);
      const numDisplay = secNum === 0 ? '★' : `${secNum}`;

      const unitBtn = document.createElement('button');
      unitBtn.className = 'w-full p-2.5 rounded-xl border border-slate-200 bg-white hover:border-rose-300 hover:bg-rose-50/50 flex items-center justify-between text-left transition text-xs font-semibold text-slate-800 shadow-2xs';
      unitBtn.innerHTML = `
        <div class="flex items-center space-x-2">
          <span class="w-6 h-6 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center font-bold text-[11px]">${numDisplay}</span>
          <span>${secTitle}</span>
        </div>
        <div class="flex items-center space-x-1 text-slate-400">
          <span class="text-[10px] bg-slate-100 px-1.5 py-0.5 rounded">${secCards.length}語</span>
          <i data-lucide="chevron-right" class="w-3.5 h-3.5"></i>
        </div>
      `;
      lucide.createIcons({ root: unitBtn });

      unitBtn.addEventListener('click', () => {
        startStudyingSection(secNum, secTitle);
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

    // Update active study header
    const fc = FOLDER_CONFIGS.find(f => f.id === currentFolder);
    document.getElementById('activeStudySectionName').textContent = sectionTitle;
    document.getElementById('activeStudyFolderName').textContent = fc ? `${fc.title}` : '';

    // Switch panels
    document.getElementById('folderOverviewPanel').classList.add('hidden');
    document.getElementById('unitListPanel').classList.add('hidden');
    document.getElementById('activeStudyHeader').classList.remove('hidden');

    updateActiveDeck();
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
    } else {
      document.getElementById('backExampleJa').parentElement.classList.add('hidden');
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
  }

  function flipCard() {
    const cardEl = document.getElementById('flashcardElement');
    if (!cardEl) return;
    isCardFlipped = !isCardFlipped;
    if (isCardFlipped) {
      cardEl.classList.add('rotate-y-180');
    } else {
      cardEl.classList.remove('rotate-y-180');
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
      let starredCards = vocabList.filter(c => mylistSet.has(c.id));
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
      speakJapanese(quizCurrentQuestion.word);
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

  // --- Mylist View Rendering with Custom Folders ---
  function renderMylistView() {
    renderMylistFolderTabs();
    renderMylistItems();
  }

  function renderMylistFolderTabs() {
    const tabsContainer = document.getElementById('mylistFolderTabs');
    if (!tabsContainer) return;
    tabsContainer.innerHTML = '';

    // 'All' tab
    const allStarredCount = vocabList.filter(c => mylistSet.has(c.id)).length;
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
      const folderCardsCount = vocabList.filter(c => mylistSet.has(c.id) && mylistCardFolderMap[c.id] === folder.id).length;
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

    let displayedCards = vocabList.filter(c => mylistSet.has(c.id));
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
            <span class="text-xs text-slate-400">（${card.reading || ''}）</span>
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
      item.querySelector('.btn-voice').addEventListener('click', () => speakJapanese(card.word));

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
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between p-2 rounded-xl bg-white border border-slate-200 shadow-2xs text-xs';
      row.innerHTML = `
        <div class="flex items-center space-x-1.5 truncate">
          <span class="font-mono text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">${st.id}</span>
          <span class="font-bold text-slate-800 truncate">${st.name}</span>
          <span class="text-[9px] px-1.5 py-0.2 rounded font-semibold bg-lightBlueBg text-deepNavy">${st.lang}</span>
        </div>
        <div class="flex items-center space-x-2 shrink-0">
          <span class="font-mono text-xs text-rose-600 font-bold bg-rose-50 px-2 py-0.5 rounded-lg border border-rose-100">
            PIN: ${st.passcode}
          </span>
          ${!isTeacher ? `
            <button class="btn-delete-student p-1 text-slate-300 hover:text-rose-500 transition" title="生徒を削除">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          ` : '<span class="text-[10px] text-slate-400 font-bold px-1">先生</span>'}
        </div>
      `;
      lucide.createIcons({ root: row });

      if (!isTeacher) {
        const delBtn = row.querySelector('.btn-delete-student');
        if (delBtn) {
          delBtn.addEventListener('click', () => {
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
    } else if (viewName === 'admin') {
      document.getElementById('viewAdmin').classList.remove('hidden');
    }
  }

  // --- Setup Event Listeners ---
  function setupListeners() {
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
      // Prevent flipping if clicked on audio button
      if (e.target.closest('button')) return;
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

    // Mark Known button
    document.getElementById('btnMarkKnown').addEventListener('click', () => {
      if (!activeDeck[currentIndex]) return;
      const card = activeDeck[currentIndex];
      knownSet.add(card.id);
      showToast(`Marked "${card.word}" as learned! 👍`);
      if (currentIndex < activeDeck.length - 1) {
        currentIndex++;
        renderCurrentCard();
      }
    });

    // Speech Audio buttons
    document.getElementById('btnSpeakFront').addEventListener('click', (e) => {
      e.stopPropagation();
      if (activeDeck[currentIndex]) {
        speakJapanese(activeDeck[currentIndex].word);
      }
    });

    document.getElementById('btnSpeakBack').addEventListener('click', (e) => {
      e.stopPropagation();
      if (activeDeck[currentIndex]) {
        speakJapanese(activeDeck[currentIndex].word);
      }
    });

    document.getElementById('btnSpeakExample').addEventListener('click', (e) => {
      e.stopPropagation();
      if (activeDeck[currentIndex] && activeDeck[currentIndex].example) {
        speakJapanese(activeDeck[currentIndex].example.ja);
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
      let targetCards = vocabList.filter(c => mylistSet.has(c.id));
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
        let targetCards = vocabList.filter(c => mylistSet.has(c.id));
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

    // Login modal toggles
    document.getElementById('userBtn').addEventListener('click', () => {
      document.getElementById('loginModal').classList.remove('hidden');
    });

    document.getElementById('btnLoginCancel').addEventListener('click', () => {
      document.getElementById('loginModal').classList.add('hidden');
    });

    document.getElementById('btnLoginSubmit').addEventListener('click', () => {
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

      const student = students.find(s => 
        (s.id.toLowerCase() === studentIdInput.toLowerCase() || s.name.toLowerCase() === studentIdInput.toLowerCase()) &&
        s.passcode === passcodeInput
      );

      if (student) {
        setStudent(student);
        document.getElementById('loginModal').classList.add('hidden');
      } else {
        showToast('Invalid Student ID or passcode');
      }
    });

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
        const nextPasscodeStr = String(1000 + nextNum);

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
        showToast(`生徒「${nameVal}」（ID: ${idVal}）を追加しました！✨`);
      });
    }
  }

  // --- App Startup ---
  function startup() {
    initData();
    setupListeners();
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
