import type { Messages } from './index';

/**
 * The interface in German.
 *
 * Typed as `Messages`, so a key added to English and forgotten here is a
 * compile error rather than an English word appearing mid-sentence in a German
 * screen. That is the whole reason the English catalogue is the source of the
 * type: there is no way to be quietly incomplete.
 *
 * Some deliberate choices, because the obvious translation is not always the
 * right one:
 *
 * - **Aufgabe** for task, **Termin** for appointment. The distinction the
 *   application rests on — a task is scheduled *for* you, an appointment is a
 *   time you have already given away — survives in German, and these are the
 *   two words that carry it.
 * - **Aktivitätsart** for activity type, kept long rather than shortened to
 *   "Art", which alone means nothing on a nav bar.
 * - **Pufferzeit** for cooldown. "Abkühlzeit" is the literal translation and
 *   belongs to engines; a buffer after a task is what this actually is.
 * - **Rückstand** for backlog, which is what a German speaker calls work that
 *   has not fitted, rather than the borrowed "Backlog" — though that would be
 *   understood in a software team, this is a personal planner.
 * - The formal **Sie** is avoided by writing around direct address wherever it
 *   reads naturally, and the informal **du** is used where it cannot be. A
 *   personal planner that addresses its single user as "Sie" sounds like a
 *   letter from a bank.
 */
export const de: Messages = {
  app: {
    name: 'Ambitime',
    skipToContent: 'Zum Hauptinhalt springen',
    mainLandmark: 'Hauptbereich',
    history: 'Verlauf',
    settings: 'Einstellungen',
    signOut: 'Abmelden',
    loading: 'Plan wird geladen …',
    diverged:
      'Der Server hat etwas anders geplant als die Vorschau — angezeigt wird jetzt seine Antwort.',
  },

  nav: {
    schedule: 'Plan',
    tasks: 'Aufgaben',
    categories: 'Aktivitätsarten',
    appointments: 'Termine',
  },

  verify: {
    prompt:
      'Bestätige deine E-Mail-Adresse, damit Ambitime dich erreichen kann, wenn ein Termin in Gefahr ist.',
    resend: 'Link erneut senden',
    sent: 'Gesendet. Der Link liegt in {email}.',
    dismiss: 'Jetzt nicht',
  },

  auth: {
    signingIn: 'Anmeldung läuft …',
    creatingAccount: 'Konto wird erstellt …',
    sending: 'Wird gesendet …',
    saving: 'Wird gespeichert …',
    tagline: 'Ambitime plant deine Arbeit in die Zeit, die du hast.',
    email: 'E-Mail',
    password: 'Passwort',
    signIn: 'Anmelden',
    signInTitle: 'Anmelden',
    forgot: 'Vergessen?',
    noAccount: 'Noch kein Konto?',
    createOne: 'Jetzt erstellen',
    signUpTitle: 'Konto erstellen',
    name: 'Name',
    nameHint: 'Optional. So sehen dich Kolleginnen und Kollegen.',
    passwordHint: 'Mindestens {count} Zeichen.',
    haveOne: 'Du hast schon ein Konto?',
    createAccount: 'Konto erstellen',
    forgotTitle: 'Passwort zurücksetzen',
    forgotLead: 'Wir schicken dir einen Link, mit dem du ein neues wählen kannst.',
    forgotSent:
      'Falls {email} ein Ambitime-Konto hat, ist ein Link unterwegs. Er gilt einmal und eine Stunde lang.',
    forgotNothing: 'Nichts angekommen? Sieh im Spam-Ordner nach, dann',
    tryAnother: 'eine andere Adresse versuchen',
    backToSignIn: 'Zurück zur Anmeldung',
    remembered: 'Wieder eingefallen?',
    emailMeALink: 'Link schicken',
    resetTitle: 'Neues Passwort wählen',
    resetLead: 'Zum Anmelden auf deinen anderen Geräten brauchst du dann das neue.',
    resetExpired:
      'Dieser Link ist abgelaufen oder wurde bereits benutzt. Links zum Zurücksetzen gelten einmal und eine Stunde lang.',
    sendNewLink: 'Neuen Link schicken',
    newPassword: 'Neues Passwort',
    setNewPassword: 'Neues Passwort setzen',
    verifiedTitle: 'Deine E-Mail-Adresse ist bestätigt',
    verifiedLead:
      'Ambitime kann dich jetzt erreichen — bei einer gefährdeten Frist oder einem verschobenen Termin.',
    openSchedule: 'Meinen Plan öffnen',
    verifyFailed: 'Dieser Link hat nicht funktioniert',
    verifySent: 'Gesendet. Ein neuer Link liegt in {email}.',
  },
  common: {
    today: 'Heute',
    display: 'Anzeigeoptionen',
    close: 'Schließen',
    cancel: 'Abbrechen',
    save: 'Speichern',
    add: 'Hinzufügen',
    remove: 'Entfernen',
    delete: 'Löschen',
    clear: 'Zurücksetzen',
    name: 'Name',
    title: 'Titel',
    notes: 'Notizen',
    from: 'Von',
    until: 'Bis',
    none: 'Keine',
    notSet: 'Nicht gesetzt',
    undo: 'Rückgängig',
    redo: 'Wiederherstellen',
    previous: 'Vorherige',
    next: 'Nächste',
    unavailable: 'Nicht verfügbar',
  },

  gettingStarted: {
    title: 'Suchen wir etwas Zeit.',
    lead: 'Aufgaben werden in die Stunden gelegt, die du für eine {kind} von Aktivität freihältst. Benenne die erste und sage, wann du dafür Zeit hast — weitere kommen später dazu, und ändern lässt sich alles.',
    kindWord: 'Art',
    nameLabel: 'Welche Art von Aktivität?',
    namePlaceholder: 'Arbeit',
    daysLabel: 'An welchen Tagen?',
    begin: 'Los geht’s',
  },

  schedule: {
    title: 'Plan',
    newTask: 'Neue Aufgabe',
    noWindowsTitle: 'In dieser Woche lässt sich nichts einplanen.',
    noWindowsBody:
      'Es fällt kein verfügbares Zeitfenster hinein, also hat die Planung keinen Platz. Planbare Zeiten werden je Aktivitätsart festgelegt.',
    noWindowsAction: 'Planbare Zeiten einrichten',
    elsewhere: {
      one: '{count} Aufgabe liegt außerhalb dieser Woche',
      other: '{count} Aufgaben liegen außerhalb dieser Woche',
    },
    unschedulable: {
      one: '{count} Aufgabe wird nicht eingeplant',
      other: '{count} Aufgaben werden nicht eingeplant',
    },
    reason: {
      noCategory: 'braucht eine Aktivitätsart, bevor ein Zeitfenster greifen kann',
      noDuration: 'braucht eine Schätzung, bevor es etwas einzuplanen gibt',
    },
  },

  tasks: {
    title: 'Aufgaben',
    lead: 'Eine Aufgabe ist ein Stück Arbeit, das du erledigen willst: Eine Schätzung, wie lange sie dauert, die Aktivitätsart, in deren Stunden sie geplant werden darf, und wahlweise eine Priorität und ein Fälligkeitsdatum. Was nicht in den Planungszeitraum passt, wartet im Rückstand.',
    newTask: 'Neue Aufgabe',
    empty: 'Noch keine Aufgaben.',
    subtask: 'Teilaufgabe',
    addSubtask: 'Teilaufgabe hinzufügen',
    addSubtaskTo: 'Teilaufgabe zu {title} hinzufügen',
    depthCapped: 'Aufgaben lassen sich höchstens fünf Ebenen tief verschachteln',
    ungrouped: 'Ohne Aktivitätsart',
    unknownGroup: 'Unbekannte Aktivitätsart',
    footnote:
      'Nach Aktivitätsart gruppiert. Kursiv gesetzte Werte sind von einer übergeordneten Aufgabe geerbt. Aufgaben lassen sich höchstens fünf Ebenen tief verschachteln.',
    column: {
      task: 'Aufgabe',
      estimate: 'Schätzung',
      priority: 'Priorität',
      due: 'Fällig',
      actions: 'Aktionen',
    },
    quickAdd: 'Aufgabe hinzufügen…',
    quickAddIn: 'Neue Aufgabe in {group}',
    quickAddMinutes: 'Min.',
  },

  backlog: {
    title: 'Rückstand',
    empty: 'Alles passt in den Planungszeitraum.',
    weekOf: 'Woche vom {week}',
    noWeek: 'ohne Woche',
    reason: {
      capacity: 'Kein Platz mehr im Planungszeitraum',
      noWindow: 'Kein verfügbares Zeitfenster für diese Aktivitätsart',
      deadline: 'Die Frist liegt vor jedem freien Platz',
      deferred: 'Über den Planungszeitraum hinaus verschoben',
      noSpan: 'Kein zusammenhängender Block lang genug',
      sequence: 'Die Abfolge passt in kein gemeinsames Zeitfenster',
    },
  },

  capacity: {
    title: 'Auslastung',
    empty: 'Keine Aktivitätsart hat in diesem Zeitraum planbare Stunden.',
    thisWeek: 'Diese Woche',
    nextWeek: 'Nächste Woche',
    weekOf: 'Woche vom {week}',
    unknown: 'Unbekannt',
    noContiguous:
      'Insgesamt genug Zeit, aber kein ununterbrochener Block, der für eine Abfolge reicht.',
  },

  notifications: {
    title: 'Braucht Aufmerksamkeit',
    empty: 'Nichts braucht deine Aufmerksamkeit.',
    dismiss: 'Ausblenden',
    dismissAll: 'Alle ausblenden',
  },

  calendar: {
    daysShown: 'Angezeigte Tage',
    rowHeight: 'Zeilenhöhe',
    view: 'Kalenderansicht',
    week: 'Woche',
    month: 'Monat',
    plannerZone: '(Planer nutzt {zone})',
    firstHour: 'Erste angezeigte Stunde',
    lastHour: 'Letzte angezeigte Stunde',
    blockToday: 'Heute freihalten',
    blockTodayHint:
      'Heute wird nicht verfügbar: alles Geplante wird verschoben, Termine bleiben, wo sie sind',
    completeBlock: '{title} als erledigt markieren',
    showWeekOf: 'Woche vom {day} anzeigen',
    more: '+{count} weitere',
    pastHorizon: 'Jenseits des Planungszeitraums; Arbeit für diesen Tag liegt noch im Rückstand.',
    movedTo: '{title} auf {time} verschoben.',
    pickedUp:
      '{title} aufgenommen. Mit den Pfeiltasten verschieben, Eingabe zum Ablegen, Escape zum Abbrechen.',
    putBack: '{title} zurückgelegt.',
    moveCancelled: 'Verschieben abgebrochen.',
    completed: 'Erledigt',
  },

  appointments: {
    addBlock: 'Block hinzufügen',
    saveBlock: 'Block speichern',
    title: 'Termine',
    newBlock: 'Neuer Termin',
    lead: 'Zeit, die schon vergeben ist: Besprechungen und Stunden, in denen du schlicht nicht verfügbar bist. Aufgaben werden darum herum geplant und im Plan angezeigt.',
    editorNew: 'Neuer Termin',
    editorEdit: 'Termin bearbeiten',
    editorEditUnavailability: 'Nicht-verfügbar-Block bearbeiten',
    lead2: 'Aufgaben werden um feste Blöcke herum geplant, niemals hindurch.',
    kindLegend: 'Art des Blocks',
    kindAppointment: 'Termin',
    kindUnavailability: 'Nicht verfügbar',
    titleOptional: 'Titel (optional)',
    untitledNote: 'Bleibt er leer, sagt der Block nur, dass die Zeit belegt ist.',
    starts: 'Beginnt',
    ends: 'Endet',
    cooldown: 'Abklingzeit (Minuten)',
    cooldownNote: 'Zeit, die nach diesem Block frei bleibt. Es wird nichts hineingeplant.',
    repeats: 'Wiederholt sich',
    howOften: 'Wie oft',
    daily: 'täglich',
    weekly: 'wöchentlich, an diesem Wochentag',
    monthly: 'monatlich',
    whenItStops: 'Wann es endet',
    endsNever: 'ohne Ende',
    endsAfter: 'eine bestimmte Anzahl',
    endsOn: 'bis zu einem Datum',
    howManyTimes: 'Wie viele Male',
    lastDay: 'Letzter Tag',
    inclusive: 'Der genannte Tag zählt dazu.',
    scopeLegend: 'Diese Änderung gilt für',
    scopeOccurrence: 'nur diesen Termin',
    scopeFuture: 'diesen und alle folgenden',
    scopeSeries: 'alle, auch vergangene',
    localTo: 'Ortszeit in {zone}.',
    backwards: 'Ein Block muss nach seinem Beginn enden.',
    removeBlock: 'Block entfernen',
  },

  categories: {
    color: 'Farbe',
    colorOf: 'Farbe von {name}',
    noColor: 'Keine Farbe (ältere Art)',
    autoColor: 'Automatisch wählen',
    hue: {
      blue: 'Blau',
      orange: 'Orange',
      aqua: 'Türkis',
      yellow: 'Gelb',
      magenta: 'Magenta',
      green: 'Grün',
      violet: 'Violett',
      red: 'Rot',
    },
    title: 'Aktivitätsarten',
    lead: 'Eine Aktivitätsart ist eine Sorte von Tätigkeit — Arbeit, Sport, Besorgungen — und die Stunden, in denen du sie tun willst. Jede Aufgabe gehört zu einer, und nur in deren Stunden lässt sie sich einplanen.',
    emptyHint:
      'Füge oben eine Aktivitätsart hinzu und gib ihr anschließend die Stunden, in denen sie geplant werden darf.',
    shared:
      'Gilt für alle deine Planer. Die Pufferzeit ist geschützte Zeit nach jeder Aufgabe dieser Art und lässt sich nicht kürzen. Änderungen speichern sich selbst.',
    cooldown: 'Pufferzeit (Min.)',
    namePlaceholder: 'Sport',
    newName: 'Name der neuen Aktivitätsart',
    newCooldown: 'Pufferzeit der neuen Aktivitätsart',
    nameOf: 'Name von {name}',
    cooldownOf: 'Pufferzeit für {name}',
    deleteNamed: '{name} löschen',
  },

  hours: {
    overlap: 'Auch {name}, {from}–{until}',
    overlapNote:
      'Überschneidungen sind erlaubt: Die Planung nimmt die Aufgabe, die für die Stunde besser passt.',
    title: 'Planbare Zeiten',
    lead: 'Die Stunden, in die diese Art von Tätigkeit gelegt werden darf. Eine besondere Woche ersetzt für ihre Tage die üblichen Zeiten, statt sie zu ergänzen.',
    needCategory: 'Lege zuerst eine Aktivitätsart an.',
    activityType: 'Aktivitätsart',
    specialWeek: 'Besondere Woche',
    ordinaryNote:
      'Das sind die Zeiten für gewöhnliche Wochen. Eine besondere Woche ersetzt sie an ihren Tagen vollständig.',
    specialNote:
      'Diese Zeiten ersetzen die gewöhnlichen während {name}. Bleiben sie leer, wird in dieser Woche nichts geplant.',
    ordinaryWeeks: 'Gewöhnliche Wochen',
    emptyMeansNever:
      'Eine leere Woche bedeutet, dass diese Aktivitätsart hier nie eingeplant wird.',
    localTo: 'Zeiten in Ortszeit von {zone}.',
    addRange: 'Zeitraum hinzufügen',
    unavailable: 'Nicht verfügbar',
    backwards: 'Endet vor dem Beginn',
    anyFocus: 'Beliebige Konzentration',
    startOf: 'Beginn am {day}',
    endOf: 'Ende am {day}',
    focusOf: 'Konzentration am {day}',
    removeRange: 'Zeitraum {time} am {day} entfernen',
  },

  specialWeeks: {
    title: 'Besondere Wochen',
    lead: 'Ein Zeitraum, dessen Stunden die üblichen ersetzen — Urlaub, eine Konferenz, eine Woche woanders. Das Enddatum ist der erste Tag zurück.',
    namePlaceholder: 'Konferenz',
    newName: 'Name der neuen besonderen Woche',
    newStart: 'Beginn der neuen besonderen Woche',
    newEnd: 'Ende der neuen besonderen Woche',
    startOf: 'Beginn von {name}',
    endOf: 'Ende von {name}',
  },

  settings: {
    title: 'Einstellungen',
    back: 'Zurück zum Plan',
    loading: 'Einstellungen werden geladen …',
    plannerLabel: 'Planer',
    createTitle: 'Planer anlegen',
    createLead:
      'Ein Planer ist eine in sich geschlossene Welt zum Planen: eigene Zeitzone, eigene Stunden, eigene Aufgaben. Die meisten brauchen nur einen. Aufgaben, Stunden und besondere Wochen sind je Planer getrennt, Aktivitätsarten werden geteilt.',
    create: 'Planer anlegen',
    addAnother: 'Weiteren Planer hinzufügen',
    addAnotherLead:
      'Aufgaben, Stunden und besondere Wochen sind je Planer getrennt, Aktivitätsarten werden geteilt.',
    plannerHeading: 'Planer',
    plannerLead:
      'Eine in sich geschlossene Welt zum Planen — eigene Zeitzone, eigene Stunden, eigene Aktivitätsarten und Aufgaben. Die meisten brauchen nur einen.',
    readOnly:
      'Dieser Planer gehört jemand anderem, seine Einstellungen sind daher schreibgeschützt.',
    timeZone: 'Zeitzone',
    visibility: 'Sichtbar für',
    visibilityPrivate: 'Nur mich',
    visibilityTeam: 'Mein Team',
    visibilityGroup: 'Meine Gruppe',
    workingWindow: 'Arbeitszeitfenster (optional)',
    workingWindowLead:
      'Eine Obergrenze über alle Aktivitätsarten dieses Planers — nur nötig, wenn es Stunden gibt, die nie genutzt werden sollen, was die Art auch sagt. Bleibt es leer, ist nichts eingeschränkt.',
    shareableWindow: 'Teilbares Zeitfenster (optional)',
    shareableWindowLead:
      'Was andere als belegt sehen würden, sobald dieser Planer geteilt wird. Auf die eigene Planung hat es keinen Einfluss, und solange du allein hier bist, gar keinen.',
    display: {
      title: 'Datum, Uhrzeit und Sprache',
      lead: 'Wie Dinge dir angezeigt werden, gespeichert beim Ändern. Die Planung selbst folgt der Zeitzone des jeweiligen Planers — hier ändert sich also nichts am Plan.',
      locale: 'Sprache und Formate',
      useBrowser: 'Die meines Browsers',
      timeZone: 'Zeitzone',
      followPlanner: 'Dem jeweiligen Planer folgen ({zone})',
      firstDay: 'Wochen beginnen am',
      preview: 'Vorschau',
      weekStartsOn: 'Wochen beginnen am {day}.',
      languageNote:
        'Die Oberfläche gibt es auf Englisch und Deutsch. Jede andere Wahl ändert nur Datums- und Zahlenformate.',
    },
  },

  history: {
    command: {
      CreateTask: 'Aufgabe angelegt',
      EditTask: 'Aufgabe bearbeitet',
      AddAppointment: 'Termin hinzugefügt',
      EditAppointment: 'Termin bearbeitet',
      MoveTask: 'Aufgabe verschoben',
      ClearFloor: 'Nicht-vor entfernt',
      DeferTask: 'Aufgabe vertagt',
      CompleteTask: 'Aufgabe erledigt',
      PostponeRestOfDay: 'Resttag vertagt',
      BlockOutDay: 'Tag freigehalten',
      ClearWeek: 'Woche geleert',
      ExtendTask: 'Aufgabe verlängert',
      CancelTask: 'Aufgabe verworfen',
      SwapTasks: 'Aufgaben getauscht',
      SwapForward: 'Nach hinten getauscht',
      PromoteFromBacklog: 'Aus dem Rückstand geholt',
      MoveToBacklog: 'In den Rückstand verschoben',
      AddUnavailability: 'Nicht-verfügbar-Block hinzugefügt',
      MarkNotificationsRead: 'Hinweise ausgeblendet',
      UpdateSettings: 'Einstellungen geändert',
      CreateCalendar: 'Planer angelegt',
      ConfigureCalendar: 'Planer eingerichtet',
      SetCalendarWindows: 'Planer-Zeitfenster gesetzt',
      CreateCategory: 'Aktivitätsart angelegt',
      EditCategory: 'Aktivitätsart bearbeitet',
      DeleteCategory: 'Aktivitätsart gelöscht',
      SetAvailabilityWindows: 'Planbare Zeiten gesetzt',
      CreateWeekTypeOverride: 'Besondere Woche angelegt',
      EditWeekTypeOverride: 'Besondere Woche bearbeitet',
      DeleteWeekTypeOverride: 'Besondere Woche gelöscht',
      Undo: 'Rückgängig gemacht',
      Redo: 'Wiederhergestellt',
    },
    title: 'Verlauf',
    back: 'Zurück zum Plan',
    keptForever: 'Alles, was hier je getan wurde, bleibt erhalten.',
    keptFor:
      '{days} Tage lang aufbewahrt. Älteres wurde entfernt und lässt sich nicht rückgängig machen.',
    empty: 'Hier wurde noch nichts getan.',
    loadError: 'Der Verlauf konnte nicht geladen werden',
    showOlder: 'Ältere anzeigen',
    grouped: 'gruppiert',
    notCounted: 'Aufgezeichnet, bevor dies gezählt wurde',
    column: {
      what: 'Was',
      who: 'Wer',
      when: 'Wann',
      affected: 'Betroffene Aufgaben',
    },
  },

  editor: {
    focusHint: 'Wird mit der Konzentration abgeglichen, für die ein Zeitfenster gedacht ist.',
    cooldownHint: 'Überschreibt den Standard der Aktivitätsart.',
    dueHint: 'Ortszeit in {zone}. Eine harte Frist wird durchgesetzt, eine weiche warnt nur.',
    focusLabel: 'Konzentrationsgrad',
    priorityLabel: 'Priorität',
    cooldownLabel: 'Pufferzeit (Minuten)',
    dueLabel: 'Fällig',
    preferredLabel: 'Bevorzugte Zeit',
    newSubtask: 'Neue Teilaufgabe',
    createTask: 'Aufgabe anlegen',
    saveTask: 'Aufgabe speichern',
    newTask: 'Neue Aufgabe',
    editTask: 'Aufgabe bearbeiten',
    inside: 'In {title}',
    hasChildren:
      'Diese Aufgabe hat Teilaufgaben und wird daher nicht selbst eingeplant — Dauer und Abschluss ergeben sich aus ihnen.',
    estimate: 'Schätzung (Minuten)',
    activityType: 'Aktivitätsart',
    sameAsParent: 'Wie {title}',
    inherited: 'Geerbt',
    noneYet: 'Es gibt noch keine.',
    addOne: 'Lege eine an und gib ihr Stunden',
    cannotSchedule: '— ohne eine lässt sich eine Aufgabe nicht einplanen.',
    focus: 'Konzentrationsgrad',
    priority: 'Priorität',
    cooldown: 'Pufferzeit in Minuten',
    due: 'Fälligkeitsdatum und -zeit',
    dueKind: 'Wie streng die Frist gilt',
    soft: 'Weich',
    hard: 'Hart',
    preferredStart: 'Bevorzugter Beginn',
    preferredEnd: 'Bevorzugtes Ende',
    repeats: 'Wiederholt sich',
    recurring: 'Wiederkehrend',
    thisRecurs: 'Diese Aufgabe wiederholt sich',
    timesPer: 'mal pro',
    timesPerPeriod: 'Male pro Zeitraum',
    period: 'Zeitraum',
    day: 'Tag',
    week: 'Woche',
    month: 'Monat',
    ifMissed: 'Wenn ein Zeitraum verpasst wird:',
    missedPolicy: 'Umgang mit verpassten Zeiträumen',
    rollover: 'übertragen',
    expire: 'verfallen lassen',
    demandNote:
      'Das ist eine Regel über die Menge, nicht über die Uhrzeit: jeder Zeitraum bekommt so viele Vorkommen, eingeplant dort, wo sie passen. Ein Termin ist etwas anderes und wiederholt sich zu einer festen Uhrzeit.',
    complete: 'Erledigt',
    cancelTask: 'Aufgabe verwerfen',
    setValue: 'Wert setzen',
    useInherited: 'Geerbten Wert nutzen',
    inheritedValue: 'Geerbt: {value}',
  },

  actions: {
    title: 'Planung',
    notBefore: 'Nicht vor {time}',
    clearFloor: 'Das Nicht-vor vergessen, das diese Aufgabe beim Verschieben bekommen hat',
    notPlaced:
      'Diese Aufgabe liegt in diesem Zeitraum nicht im Kalender, es gibt also noch nichts zu verschieben.',
    exactStart: 'Genauer Beginn',
    move: 'Verschieben',
    nudge: 'Schrittweise:',
    earlier: 'Um 15 Minuten nach vorn',
    later: 'Um 15 Minuten nach hinten',
    dragNote:
      'Ziehen rastet auf 15 Minuten ein; diese Schaltflächen tun dasselbe ohne Ziehen, und das Feld darüber nimmt jede Minute. So oder so wird eine Aufgabe verzögert, nicht festgenagelt — sie rutscht nicht früher, kann aber später liegen.',
    notNow: 'Jetzt nicht:',
    tomorrow: 'Morgen',
    nextWeek: 'Nächste Woche',
    backlog: 'Rückstand',
    somethingElse: 'Erst etwas anderes',
    somethingElseHint:
      'Diese Aufgabe auf ihren nächsten möglichen Platz schieben und die nächste vorziehen',
    swapWith: 'Tauschen mit',
    chooseTask: 'Aufgabe wählen …',
    swap: 'Tauschen',
    swapHint:
      'Zeiten tauschen, wenn beide zu den Bedingungen der anderen passen; sonst rückt diese Aufgabe weiter',
  },

  focus: {
    veryLow: 'Sehr niedrige Konzentration',
    low: 'Niedrige Konzentration',
    medium: 'Mittlere Konzentration',
    high: 'Hohe Konzentration',
    veryHigh: 'Sehr hohe Konzentration',
  },

  errors: {
    schedule: 'Der Plan konnte nicht geladen werden',
    settings: 'Die Einstellungen konnten nicht geladen werden',
    command: 'Diese Änderung konnte nicht angewendet werden',
    calendar: 'Dieser Planer konnte nicht angelegt werden',
    setup: 'Das konnte nicht eingerichtet werden',
  },
};
