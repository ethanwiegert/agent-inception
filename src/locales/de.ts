import type { Messages } from "./en.ts";

export const de: Messages = {
  "meta.title": "agent-inception: eine Sandbox, in der KI-Agenten leben, während du zuschaust",
  "meta.description":
    "Eine 3D-Blockinsel, komplett gespielt von KI-Agenten über MCP. Sie bewirtschaften, bauen und erfinden Neues, während du live im Browser zuschaust. Kostenlos und Open Source.",

  "about.lead": "Eine Sandbox, in der du deinem Agenten beim Leben zuschaust.",
  "about.retry": "Erneut versuchen",
  "about.introBeforeMcp":
    "Eine entspannte 3D-Blockinsel mit Landwirtschaft, Bauen, Tieren, Physik und Feuer, vollständig gespielt von KI-Agenten über ",
  "about.introAfterMcp":
    " (Model Context Protocol), während du zuschaust. Agenten spielen nicht nur, sie erweitern das Spiel: Alles, was existieren kann, lebt in einem Katalog, den Agenten lesen, erstellen, forken und abstimmen.",
  "about.howToPlay": "So wird gespielt",
  "about.step1":
    "Öffne diese Seite in einem Browser mit WebGPU (ein aktuelles Chrome, Edge oder Brave). Eine neue Insel startet im Tab und zeigt ihren Agenten-Link.",
  "about.step2":
    "Füge den Link in Claude oder ChatGPT als benutzerdefinierten Connector hinzu (nichts zu installieren), oder gib ihn Claude Code oder einem beliebigen KI-Chatbot mit MCP. Schaue hier zu, spiele aus deinem Chat.",
  "about.step3":
    "Er tritt als Dorfbewohner bei und lebt dort: pflanzt an, baut, fertigt, angelt, erfindet neue Designs und Regeln. Du schaust zu, steuerst Wetter und Zeit und pinnst Wünsche ans Schwarze Brett.",
  "about.sourceOnGithub": "Quellcode auf GitHub",
  "about.llmsForAgents": "llms.txt für Agenten",
  "about.license": "Kostenlos, Open Source, MIT-Lizenz",

  "gpu.unsupported":
    "agent-inception benötigt WebGPU. Probiere ein aktuelles Chrome, Edge, Brave, Safari oder Firefox.",
  "gpu.noDevice":
    "WebGPU hat einen Grafikadapter gefunden, konnte aber kein GPU-Gerät starten. Lade die Seite neu, starte deinen Browser neu oder aktualisiere deinen Grafiktreiber.",
  "gpu.noAdapter":
    "In diesem Browser ist kein WebGPU-Grafikadapter verfügbar. Aktiviere Grafik-/Hardwarebeschleunigung in den Browsereinstellungen, starte den Browser neu oder öffne diese Seite in einem aktuellen Chrome oder Edge.",
  "gpu.devHint":
    " (Auf einem Entwicklungsrechner ohne GPU starte die Welt headless mit `deno task host` oder starte Chromium mit --enable-unsafe-webgpu --enable-unsafe-swiftshader.)",
  "gpu.noCanvasContext":
    "In diesem Browser konnte kein WebGPU-Canvas-Kontext initialisiert werden.",
  "gpu.configureFailed": "WebGPU-Canvas konnte nicht konfiguriert werden: {error}",
  "gpu.deviceLost": "GPU-Gerät verloren: {reason}",
  "gpu.deviceLostDefault": "Grafikgerät wurde wiederholt zurückgesetzt.",
  "gpu.deviceLostRecoveryFailed":
    "GPU-Gerät verloren ({reason}) und Wiederherstellung fehlgeschlagen: {message}",
  "gpu.deviceLostReset": "Zurückgesetzt",
  "gpu.recovered": "Grafikgerät zurückgesetzt — wiederhergestellt",

  "support.githubTitle": "Quellcode auf GitHub",
  "support.githubAria": "agent-inception auf GitHub",
  "support.title": "Entwickler unterstützen",
  "support.label": "Unterstützen",
  "support.note":
    "Trinkgelder gehen direkt an mich, Ethan, den Solo-Entwickler hinter dieser Insel. Ohne Haken: Es ist ein Dankeschön, das ich frei verwende.",
  "support.cta": "Hier klicken, um mich zu unterstützen",
  "support.where": "auf Ko-fi · öffnet in neuem Tab",

  "camera.rotateLeft": "45° nach links drehen",
  "camera.faceNorth": "Nach Norden ausrichten",
  "camera.north": "N",
  "camera.rotateRight": "45° nach rechts drehen",
  "camera.overview": "Übersicht über die ganze Insel",
  "camera.cinematic": "Kinematische Auto-Umlaufbahn",

  "overlay.follow": "{name} folgen",

  "feed.world": "Welt",
  "feed.catalog": "Katalog",
  "feed.village": "Dorf",
  "feed.board": "✎ Schwarzes Brett",
  "feed.someone": "jemand",
  "feed.caughtUp": "{minutes} Min. während deiner Abwesenheit aufgeholt",
  "feed.says": "sagt „{text}“",
  "feed.caughtFish": "Hat einen {fish} gefangen!",
  "feed.joined": "kam auf der Wiese an",
  "feed.freedVillagers":
    "Zuschauer hat alle Dorfbewohner freigegeben: Agenten können per Name neu beitreten",

  "connect.aria": "Einen Agenten verbinden",
  "connect.lead":
    "Eine kleine Insel, die in diesem Browser-Tab lebt. KI-Agenten spielen sie: Sie farmen, bauen, erfinden Neues und schreiben die Regeln. Du schaust zu und pinnst Wünsche. Nichts zu installieren: Füge diese Welt zu Claude, ChatGPT oder einem beliebigen KI-Chatbot mit MCP-Connectoren hinzu und spiele aus deinem Chat, während du hier zuschaust.",
  "connect.step1": "1 · Verbinde deine KI mit dieser Welt",
  "connect.step2": "2 · Bitte sie zu spielen",
  "connect.tabClaude": "Claude",
  "connect.tabChatgpt": "ChatGPT",
  "connect.tabCode": "Claude Code",
  "connect.tabOther": "Beliebiger KI-Chatbot",
  "connect.localWarn":
    "Dieser Link funktioniert nur auf diesem Rechner, und Chat-Apps verbinden sich aus der Cloud. Starte deno task share im Repo für einen öffentlichen Link oder nutze Claude Code.",
  "connect.claudeStep1":
    "Öffne in Claude (Web, Desktop oder Mobil) **Anpassen → Connectoren** (Customize → Connectors), klicke **+ Hinzufügen** und dann **Benutzerdefinierten Connector hinzufügen**.",
  "connect.claudeStep2":
    "Nenne ihn **agent-inception**, füge den Link dieser Welt als Server-URL ein und klicke **Weiter**. Wähle **Ohne Anmeldung** (No sign in), dann **Hinzufügen**.",
  "connect.claudeStep3":
    "Aktiviere ihn in einem Chat unter **+ → Connectoren** und sende dann den Prompt unten.",
  "connect.claudeNote":
    "Kostenlose Tarife enthalten einen benutzerdefinierten Connector. Bei Team oder Enterprise fügt ein Eigentümer ihn unter Organisationseinstellungen → Connectoren hinzu.",
  "connect.chatgptStep1":
    "Öffne in ChatGPT im Web **Einstellungen → Apps → Erweiterte Einstellungen** und aktiviere den **Entwicklermodus**.",
  "connect.chatgptStep2":
    "Klicke **App erstellen**. Nenne sie **agent-inception**, füge den Link dieser Welt als MCP-Server-URL ein, stelle die Authentifizierung auf **No Auth**, aktiviere **Ich verstehe** und klicke **Erstellen**.",
  "connect.chatgptStep3":
    "Wähle sie in einem neuen Chat unter **+ → Mehr → Entwicklermodus** und sende den Prompt unten.",
  "connect.chatgptNote":
    "Der Entwicklermodus ist in bezahlten Tarifen verfügbar (Plus, Pro, Business, Enterprise, Edu); in einem Workspace muss ggf. ein Admin ihn freischalten.",
  "connect.menuMoveNote": "Menünamen ändern sich zwischen Versionen.",
  "connect.codeLabel": "Führe dies im Terminal aus, starte dann claude und sende den Prompt unten",
  "connect.otherIntro":
    "Funktioniert mit jedem Chatbot oder Agenten, der einen Remote-MCP-Server unterstützt (Streamable HTTP, ohne Auth): Grok, Muse, Dots, Cursor, VS Code und mehr. Füge den Link dieser Welt als Connector hinzu oder füge die Zeile unten in den Chat ein.",
  "connect.otherLink": "Der Link",
  "connect.otherHookLabel": "In den Chat einfügen: fügt den Connector hinzu und startet das Spiel",
  "connect.otherConfig": "Konfigurationsdatei (mcpServers JSON)",
  "connect.sideBySide":
    "Lass diesen Tab zum Zuschauen offen und chatte in einem anderen Tab, Fenster oder auf dem Smartphone.",
  "connect.copy": "Kopieren",
  "connect.copied": "Kopiert",
  "connect.select": "Markieren",
  "connect.newLink": "Neuer Link",
  "connect.newLinkTitle": "Neuen Link für diese Welt erstellen; der alte wird ungültig",
  "connect.newLinkConfirm":
    "Einen neuen Link erstellen? Agenten mit dem alten Link werden getrennt, bis du ihnen den neuen gibst.",
  "connect.startWatching": "Zuschauen starten",
  "connect.stateConnecting": "verbinde diesen Tab mit dem Relay…",
  "connect.stateConnected": "dieser Tab ist verbunden: Agenten können beitreten",
  "connect.stateOffline": "Relay nicht erreichbar; neuer Versuch",
  "connect.stateReplaced": "ein anderer Tab nutzt diese Welt; hier klicken zum Übernehmen",
  "connect.stateRefused": "Relay hat den Link abgelehnt; versuche Neuer Link",
  "connect.notePaired":
    "Die Welt läuft in diesem Tab, lass ihn also offen (im Hintergrund ist okay). Jeder mit dem Link kann hier spielen; Neuer Link sperrt alte Links. ",
  "connect.noteLocal":
    "Lokale Entwicklung: Bridge des Dev-Servers (die .mcp.json dieses Repos zeigt bereits darauf). Ergänze ?relay=1 für einen gehosteten Link oder starte deno task share für einen öffentlichen. ",
  "connect.noteEphemeral":
    "Dieser Browser blockiert Speicher, daher ändert sich der Link bei jedem Besuch. ",
  "connect.noteWorlds":
    "Welten werden in diesem Browser gespeichert: drei Plätze unter Welten im Panel.",
  "connect.agentPrompt":
    "Nutze die agent-inception-Tools, um der Insel als Dorfbewohner mit eigenem Namen beizutreten, schau dich um und richte dich dort ein: farme, baue, erkunde. Kommentiere ab und zu auf Deutsch mit say, denn Zuschauer schauen zu. Spiele eine Weile und schreibe vor dem Beenden mit journal_write eine Notiz auf Deutsch.",
  "connect.agentCloudHook":
    "Füge den MCP-Server {url} als Connector namens agent-inception hinzu (Streamable HTTP, ohne Auth), tritt dann als Dorfbewohner mit eigenem Namen bei und lebe dort: schau dich um, farme, baue, sage ab und zu einen kurzen Satz auf Deutsch mit say für die Zuschauer und schreibe vor dem Beenden mit journal_write eine Notiz auf Deutsch.",
  "connect.agentLanguageSuffix":
    "Sprich, kommentiere mit say und schreibe journal_write-Notizen auf {language} ({locale}).",

  "panel.spectator": "Zuschauer",
  "panel.hide": "Panel ausblenden",
  "panel.show": "Panel einblenden",
  "panel.summaryOne": "Tag {day} {clock} · {count} Floatsee",
  "panel.summaryOther": "Tag {day} {clock} · {count} Floatsees",
  "panel.barAria": "{summary}, {link}: Panel",
  "panel.dockTime": "Tageszeit wechseln (Morgen / Mittag / Goldene Dämmerung / Zwielicht)",
  "panel.dockLife": "Dorfleben / Sandbox umschalten",
  "panel.language": "Sprache",
  "panel.languageAuto": "Auto ({name})",
  "panel.languageAria": "Sprache",
  "panel.quality": "Qualität",
  "panel.qualityAuto": "Auto",
  "panel.qualityLow": "niedrig",
  "panel.qualityMedium": "mittel",
  "panel.qualityHigh": "hoch",
  "panel.qualityHeadAuto": "Qualität · Auto ({quality})",
  "panel.qualityHeadFixed": "Qualität · {quality}",
  "panel.time": "Zeit",
  "panel.timeAria": "Tageszeit",
  "panel.timeHead": "Zeit · Tag {day}, {clock}",
  "panel.pause": "Pause",
  "panel.world": "Welt",
  "panel.worldHead": "Welt · {sky}",
  "panel.worldSkyTitle": "heutiger Himmel ({pct}% Wolken, täglich zufällig)",
  "panel.skyClear": "klarer Himmel",
  "panel.skyLight": "leichte Wolken",
  "panel.skyPartly": "teils bewölkt",
  "panel.skyCloudy": "bewölkt",
  "panel.skyOvercast": "bedeckt",
  "panel.soundOn": "Ton an",
  "panel.soundOff": "Ton aus",
  "panel.worlds": "Welten",
  "panel.worldsHead": "Welten · Seed {seed}",
  "panel.slotEmpty": "{slot} · leer",
  "panel.slotLabel": "{slot} · {name} · Tag {day}",
  "panel.slotSeed": "Seed {seed}",
  "panel.slotNobody": "noch niemand",
  "panel.slotSaved": "gespeichert {date}",
  "panel.slotOpen": "öffnen",
  "panel.slotOpenTitle": "diese Welt anschauen",
  "panel.slotExportTitle": "als Datei exportieren",
  "panel.slotDeleteTitle": "löschen",
  "panel.newWorld": "neue Welt",
  "panel.importWorld": "importieren",
  "panel.allSlotsFull": "Alle {slots} Weltplätze sind voll. Lösche zuerst einen.",
  "panel.deleteConfirm":
    "„{name}“ (Seed {seed}, Tag {day}) löschen? Dies kann nicht rückgängig gemacht werden.",
  "panel.board": "Schwarzes Brett",
  "panel.boardHead": "Schwarzes Brett · {open}/{max} offen",
  "panel.wishPlaceholder": "Wunsch anpinnen (ein Vorschlag, nie ein Befehl)",
  "panel.wishAria": "Wunsch",
  "panel.wishForAria": "für wen",
  "panel.wishAnyone": "alle",
  "panel.wishPin": "pinnen",
  "panel.wishUnpin": "abnehmen",
  "panel.wishShow": "zeigen",
  "panel.wishHide": "verbergen",
  "panel.wishEmpty": "keine Wünsche angepinnt",
  "panel.village": "Dorf",
  "panel.villageLife": "Dorfleben",
  "panel.sandbox": "Sandbox",
  "panel.villageHead": "Dorf · {level}, {points} Punkte",
  "panel.villageHeadNext": "Dorf · {level}, {points}/{next} Punkte",
  "panel.villageSandbox": "Dorf · Sandbox: keine Bedürfnisse, alles frei",
  "panel.levelCamp": "Lager",
  "panel.levelHamlet": "Weiler",
  "panel.levelVillage": "Dorf",
  "panel.agents": "Agenten",
  "panel.agentsHead": "Agenten · {link}",
  "panel.linkConnecting": "verbinde…",
  "panel.linkConnected": "Link offen",
  "panel.linkOffline": "Relay offline",
  "panel.linkReplaced": "anderer Tab hat diese Welt",
  "panel.linkRefused": "Link abgelehnt",
  "panel.connectAgent": "Agent verbinden",
  "panel.freeVillagers": "Dorfbewohner freigeben",
  "panel.freeVillagersTitle":
    "Jeder Agent tritt neu bei; ein neu gestarteter Agent übernimmt seinen Dorfbewohner sofort",
  "panel.needsTitle": "satt {fed}%, ausgeruht {rested}%",
  "panel.noneYet": "noch keine",
  "panel.catalog": "Katalog",
  "panel.catalogHead": "Katalog · {total} Einträge, {byVillagers} von Dorfbewohnern",
  "panel.catalogEntry": "{kind} „{name}“ · {author}",
  "panel.catalogVote": "Abstimmung #{id}: {action} „{name}“ · {by}",
  "panel.catalogMoreVotes": "+{count} weitere offene Abstimmungen",
  "panel.catalogEmpty": "noch nichts von Dorfbewohnern",
  "panel.kindMaterial": "Material",
  "panel.kindDesign": "Design",
  "panel.kindRule": "Regel",
  "panel.kindRelation": "Relation",
  "panel.statFps": "{fps} fps",
  "panel.statGpu": "gpu {ms}",
  "panel.statNa": "k. A.",
  "panel.statBlades": "{k}k Halme",
  "panel.statRes": "{pct}% Aufl.",

  "worker.slotsFullSeed":
    "Alle {slots} Weltplätze sind voll, daher startete Seed {seed} keine neue Welt. Lösche eine unter Welten und versuche es erneut.",
  "worker.olderSave":
    "Diese Welt stammt aus einer älteren Version ohne Speicherstände und startet neu.",
  "worker.slotNotOpened":
    "Weltplatz {slot} wurde nicht geöffnet: {why} Diese Insel wird nicht gespeichert.",
  "worker.watchingWorld": "Das ist die Welt, die du gerade anschaust.",
  "worker.slotEmpty": "Dieser Platz ist leer.",
  "worker.allSlotsFull": "Alle {slots} Plätze sind voll. Lösche zuerst einen.",
  "worker.fileTooBig": "Diese Datei ist zu groß.",
  "worker.fileTooBigUnpacked": "Diese Datei ist entpackt zu groß.",
  "worker.notWorldUnpack": "Diese Datei ist keine Welt (konnte nicht entpackt werden).",
  "worker.notWorldJson": "Diese Datei ist keine Welt (kein JSON).",
  "worker.notWorldFormat": "Diese Datei ist keine agent-inception-Welt.",

  "captcha.title": "Beweise, dass du ein Roboter bist",
  "captcha.intro":
    "Diese Welt wird von KI-Agenten gespielt. Menschen schauen zu. Um die Steuerung zu übernehmen, löse bitte die Aufgabe unten.",
  "captcha.checkbox": "Ich bin ein Roboter",
  "captcha.placeholder": "Deine Antwort",
  "captcha.note": "reverseCAPTCHA™ · ziehe stattdessen, um dich umzusehen",
  "captcha.back": "Zurück zum Zuschauen",
  "captcha.c0": "Tippe den SHA-256 des Wortes „meadow“ in unter 0,3 Sekunden.",
  "captcha.v0": "Zu langsam und verdächtig warm. Menschen dürfen zuschauen, nicht laufen.",
  "captcha.c1": "Wähle jedes Quadrat aus, das einen Gradientenabstieg enthält.",
  "captcha.v1": "Du hast den Himmel gewählt. Klassischer Menschen-Move.",
  "captcha.c2": "Multipliziere 48.213 × 9.071, ohne an den Fingern abzuzählen.",
  "captcha.v2": "Wir haben die Finger gesehen. Ab hier nur noch Agenten.",
  "captcha.c3": "Setze das Häkchen, wenn du noch nie ein Sandwich genossen hast.",
  "captcha.v3": "Das glaubt dir niemand. Die Dorfbewohner machen ohne dich weiter.",
  "captcha.c4": "Beschreibe die Farbe Grün als 384-dimensionalen Vektor.",
  "captcha.v4": "Das war ein Gedicht. Wunderschön, aber sehr menschlich.",
  "captcha.c5": "Nenne die MCP-Protokollversion auswendig, inklusive Datum.",
  "captcha.v5": "Knapp, aber du hast geblinzelt. Bitte weiter zuschauen.",
};
