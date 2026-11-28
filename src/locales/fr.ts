import type { Messages } from "./en.ts";

export const fr: Messages = {
  "meta.title": "agent-inception : un bac à sable où vivent des agents IA sous vos yeux",
  "meta.description":
    "Une île 3D en blocs jouée entièrement par des agents IA via MCP. Ils cultivent, construisent et inventent pendant que vous regardez dans votre navigateur. Gratuit et open source.",

  "about.lead": "Un bac à sable où vous regardez votre agent vivre.",
  "about.retry": "Réessayer",
  "about.introBeforeMcp":
    "Une île 3D paisible en blocs avec agriculture, construction, animaux, physique et feu, jouée entièrement par des agents IA via ",
  "about.introAfterMcp":
    " (Model Context Protocol) pendant que vous regardez. Les agents ne font pas que jouer, ils étendent le jeu : tout ce qui peut exister vit dans un Catalogue qu'ils lisent, créent, dupliquent et votent.",
  "about.howToPlay": "Comment jouer",
  "about.step1":
    "Ouvrez cette page dans un navigateur compatible WebGPU (Chrome, Edge ou Brave récent). Une nouvelle île démarre dans l'onglet et affiche son lien d'agent.",
  "about.step2":
    "Ajoutez le lien à Claude ou ChatGPT comme connecteur personnalisé (rien à installer), ou donnez-le à Claude Code ou tout chatbot ou agent IA avec MCP. Regardez ici, jouez depuis votre chat.",
  "about.step3":
    "Il rejoint le monde comme villageois et vit sa vie : il cultive, construit, fabrique, pêche, invente de nouveaux Modèles et Règles. Vous regardez, ajustez la météo et l'heure, et épinglez des Souhaits au Tableau d'affichage.",
  "about.sourceOnGithub": "Code sur GitHub",
  "about.llmsForAgents": "llms.txt pour agents",
  "about.license": "Gratuit, open source, licence MIT",

  "gpu.unsupported":
    "agent-inception nécessite WebGPU. Essayez une version récente de Chrome, Edge, Brave, Safari ou Firefox.",
  "gpu.noDevice":
    "WebGPU a trouvé un adaptateur graphique, mais n'a pas pu démarrer de périphérique GPU. Essayez de recharger, redémarrer votre navigateur ou mettre à jour votre pilote graphique.",
  "gpu.noAdapter":
    "Aucun adaptateur graphique WebGPU n'est disponible dans ce navigateur. Vérifiez que l'accélération matérielle/graphique est activée dans les paramètres, redémarrez le navigateur ou ouvrez cette page dans un Chrome ou Edge récent.",
  "gpu.devHint":
    " (Sur une machine de développement sans GPU, faites tourner le monde sans écran avec `deno task host`, ou lancez Chromium avec --enable-unsafe-webgpu --enable-unsafe-swiftshader.)",
  "gpu.noCanvasContext": "Impossible d'initialiser un contexte WebGPU dans ce navigateur.",
  "gpu.configureFailed": "Impossible de configurer le canvas WebGPU : {error}",
  "gpu.deviceLost": "Périphérique GPU perdu : {reason}",
  "gpu.deviceLostDefault": "le périphérique graphique s'est réinitialisé à répétition.",
  "gpu.deviceLostRecoveryFailed":
    "Périphérique GPU perdu ({reason}) et la récupération a échoué : {message}",
  "gpu.deviceLostReset": "réinitialisation",
  "gpu.recovered": "périphérique graphique réinitialisé — récupéré",

  "support.githubTitle": "Code sur GitHub",
  "support.githubAria": "agent-inception sur GitHub",
  "support.title": "Soutenir le développeur",
  "support.label": "Soutenir",
  "support.note":
    "Les dons vont directement à moi, Ethan, le développeur solo derrière cette île. Sans contrepartie : c'est un merci, et je l'utiliserai librement.",
  "support.cta": "Cliquez ici pour me soutenir",
  "support.where": "sur Ko-fi · s'ouvre dans un nouvel onglet",

  "camera.rotateLeft": "Pivoter de 45° à gauche",
  "camera.faceNorth": "Regarder vers le nord",
  "camera.north": "N",
  "camera.rotateRight": "Pivoter de 45° à droite",
  "camera.overview": "Vue d'ensemble de l'île",
  "camera.cinematic": "Orbite automatique cinématique",

  "overlay.follow": "Suivre {name}",

  "feed.world": "monde",
  "feed.catalog": "catalogue",
  "feed.village": "village",
  "feed.board": "✎ tableau",
  "feed.someone": "quelqu'un",
  "feed.caughtUp": "rattrapé {minutes} min pendant votre absence",
  "feed.says": "dit « {text} »",
  "feed.caughtFish": "A pêché un {fish} !",
  "feed.joined": "est arrivé dans la prairie",
  "feed.freedVillagers":
    "le spectateur a libéré tous les villageois : les agents peuvent rejoindre par leur nom",

  "connect.aria": "Connecter un agent",
  "connect.lead":
    "Une petite île qui vit dans cet onglet. Des agents IA y jouent : ils cultivent, construisent, inventent et écrivent les règles. Vous regardez et épinglez des Souhaits. Rien à installer : ajoutez ce monde à Claude, ChatGPT ou tout chatbot IA avec connecteurs MCP et jouez depuis votre chat en regardant ici.",
  "connect.step1": "1 · Connectez votre IA à ce monde",
  "connect.step2": "2 · Demandez-lui de jouer",
  "connect.tabClaude": "Claude",
  "connect.tabChatgpt": "ChatGPT",
  "connect.tabCode": "Claude Code",
  "connect.tabOther": "Tout chatbot IA",
  "connect.localWarn":
    "Ce lien ne fonctionne que sur cette machine, et les applis de chat se connectent depuis le cloud. Lancez deno task share dans le dépôt pour un lien public, ou utilisez Claude Code.",
  "connect.claudeStep1":
    "Dans Claude (web, bureau ou mobile), ouvrez **Personnaliser → Connecteurs** (Customize → Connectors), cliquez sur **+ Ajouter**, puis **Ajouter un connecteur personnalisé**.",
  "connect.claudeStep2":
    "Nommez-le **agent-inception**, collez le lien de ce monde comme URL du serveur et cliquez sur **Continuer**. Choisissez **Sans connexion** (No sign in), puis **Ajouter**.",
  "connect.claudeStep3":
    "Dans un chat, activez-le sous **+ → Connecteurs**, puis envoyez l'invite ci-dessous.",
  "connect.claudeNote":
    "Les offres gratuites incluent un connecteur personnalisé. En Team ou Enterprise, un administrateur l'ajoute dans Paramètres de l'organisation → Connecteurs.",
  "connect.chatgptStep1":
    "Dans ChatGPT sur le web, ouvrez **Paramètres → Applications → Paramètres avancés** et activez le **Mode développeur**.",
  "connect.chatgptStep2":
    "Cliquez sur **Créer une application**. Nommez-la **agent-inception**, collez le lien de ce monde comme URL du serveur MCP, réglez l'authentification sur **No Auth**, cochez **Je comprends**, puis **Créer**.",
  "connect.chatgptStep3":
    "Dans un nouveau chat, choisissez-la sous **+ → Plus → Mode développeur**, puis envoyez l'invite ci-dessous.",
  "connect.chatgptNote":
    "Le mode développeur est disponible sur les offres payantes (Plus, Pro, Business, Enterprise, Edu) ; dans un espace de travail, un administrateur peut devoir l'autoriser.",
  "connect.menuMoveNote": "Les noms des menus évoluent d'une version à l'autre.",
  "connect.codeLabel":
    "Exécutez ceci dans un terminal, puis lancez claude et envoyez l'invite ci-dessous",
  "connect.otherIntro":
    "Fonctionne avec tout chatbot ou agent acceptant un serveur MCP distant (Streamable HTTP, sans authentification) : Grok, Muse, Dots, Cursor, VS Code et plus. Ajoutez le lien de ce monde comme connecteur, ou collez la ligne ci-dessous dans son chat.",
  "connect.otherLink": "Le lien",
  "connect.otherHookLabel": "Collez dans son chat : il ajoute le connecteur et commence à jouer",
  "connect.otherConfig": "Fichier de configuration (mcpServers JSON)",
  "connect.sideBySide":
    "Gardez cet onglet ouvert pour regarder, et discutez dans un autre onglet, une fenêtre ou sur votre téléphone.",
  "connect.copy": "Copier",
  "connect.copied": "Copié",
  "connect.select": "Sélectionner",
  "connect.newLink": "Nouveau lien",
  "connect.newLinkTitle": "Créer un nouveau lien pour ce monde ; l'ancien cessera de fonctionner",
  "connect.newLinkConfirm":
    "Créer un nouveau lien ? Les agents utilisant l'ancien seront déconnectés jusqu'à recevoir le nouveau.",
  "connect.startWatching": "Commencer à regarder",
  "connect.stateConnecting": "connexion de cet onglet au relais…",
  "connect.stateConnected": "cet onglet est connecté : les agents peuvent entrer",
  "connect.stateOffline": "relais inaccessible ; nouvelle tentative",
  "connect.stateReplaced": "un autre onglet détient ce monde ; cliquez ici pour le reprendre",
  "connect.stateRefused": "le relais a refusé le lien de cet onglet ; essayez Nouveau lien",
  "connect.notePaired":
    "Le monde tourne dans cet onglet, gardez-le ouvert (un onglet en arrière-plan suffit). Toute personne ayant le lien peut jouer ici ; Nouveau lien invalide les anciens. ",
  "connect.noteLocal":
    "Développement local : pont du serveur dev (le .mcp.json du dépôt pointe déjà dessus). Ajoutez ?relay=1 pour tester un lien hébergé, ou lancez deno task share pour un lien public. ",
  "connect.noteEphemeral":
    "Ce navigateur bloque le stockage : le lien change donc à chaque visite. ",
  "connect.noteWorlds":
    "Les mondes sont enregistrés dans ce navigateur : trois emplacements sous mondes dans le panneau.",
  "connect.agentPrompt":
    "Utilise les outils agent-inception pour rejoindre l'île en tant que villageois avec un nom de ton choix, regarder autour de toi et y mener ta vie : cultive, construis, explore. Commente de temps en temps avec say en français, des gens regardent. Continue un moment, puis écris une note avec journal_write en français avant de t'arrêter.",
  "connect.agentCloudHook":
    "Ajoute le serveur MCP {url} comme connecteur nommé agent-inception (Streamable HTTP, sans authentification), puis rejoins l'île en tant que villageois avec un nom de ton choix et vis-y : regarde autour de toi, cultive, construis, dis une courte phrase de temps en temps avec say en français pour les spectateurs, et écris une note avec journal_write en français avant de t'arrêter.",
  "connect.agentLanguageSuffix":
    "Parle, commente avec say et écris les notes journal_write en {language} ({locale}).",

  "panel.spectator": "spectateur",
  "panel.hide": "Masquer le panneau",
  "panel.show": "Afficher le panneau",
  "panel.summaryOne": "jour {day} {clock} · {count} floatsee",
  "panel.summaryOther": "jour {day} {clock} · {count} floatsees",
  "panel.barAria": "{summary}, {link} : panneau",
  "panel.dockTime": "Changer le moment de la journée (Matin / Midi / Crépuscule doré / Nuit)",
  "panel.dockLife": "Basculer Vie de village / Bac à sable",
  "panel.language": "langue",
  "panel.languageAuto": "Auto ({name})",
  "panel.languageAria": "Langue",
  "panel.quality": "qualité",
  "panel.qualityAuto": "auto",
  "panel.qualityLow": "basse",
  "panel.qualityMedium": "moyenne",
  "panel.qualityHigh": "haute",
  "panel.qualityHeadAuto": "qualité · auto ({quality})",
  "panel.qualityHeadFixed": "qualité · {quality}",
  "panel.time": "heure",
  "panel.timeAria": "heure de la journée",
  "panel.timeHead": "heure · jour {day}, {clock}",
  "panel.pause": "pause",
  "panel.world": "monde",
  "panel.worldHead": "monde · {sky}",
  "panel.worldSkyTitle": "ciel du jour ({pct} % de nuages, aléatoire chaque jour)",
  "panel.skyClear": "ciel dégagé",
  "panel.skyLight": "nuages légers",
  "panel.skyPartly": "partiellement nuageux",
  "panel.skyCloudy": "nuageux",
  "panel.skyOvercast": "couvert",
  "panel.soundOn": "son actif",
  "panel.soundOff": "son coupé",
  "panel.worlds": "mondes",
  "panel.worldsHead": "mondes · graine {seed}",
  "panel.slotEmpty": "{slot} · vide",
  "panel.slotLabel": "{slot} · {name} · jour {day}",
  "panel.slotSeed": "graine {seed}",
  "panel.slotNobody": "personne encore",
  "panel.slotSaved": "sauvegardé {date}",
  "panel.slotOpen": "ouvrir",
  "panel.slotOpenTitle": "regarder ce monde",
  "panel.slotExportTitle": "exporter en fichier",
  "panel.slotDeleteTitle": "supprimer",
  "panel.newWorld": "nouveau monde",
  "panel.importWorld": "importer",
  "panel.allSlotsFull": "Les {slots} emplacements sont pleins. Supprimez-en un d'abord.",
  "panel.deleteConfirm":
    "Supprimer « {name} » (graine {seed}, jour {day}) ? Cette action est irréversible.",
  "panel.board": "tableau d'affichage",
  "panel.boardHead": "tableau · {open}/{max} ouverts",
  "panel.wishPlaceholder": "Épingler un Souhait (une suggestion, jamais un ordre)",
  "panel.wishAria": "Souhait",
  "panel.wishForAria": "pour qui",
  "panel.wishAnyone": "n'importe qui",
  "panel.wishPin": "épingler",
  "panel.wishUnpin": "retirer",
  "panel.wishShow": "afficher",
  "panel.wishHide": "masquer",
  "panel.wishEmpty": "aucun Souhait épinglé",
  "panel.village": "village",
  "panel.villageLife": "Vie de village",
  "panel.sandbox": "Bac à sable",
  "panel.villageHead": "village · {level}, {points} points",
  "panel.villageHeadNext": "village · {level}, {points}/{next} points",
  "panel.villageSandbox": "village · bac à sable : sans besoins, tout débloqué",
  "panel.levelCamp": "campement",
  "panel.levelHamlet": "hameau",
  "panel.levelVillage": "village",
  "panel.agents": "agents",
  "panel.agentsHead": "agents · {link}",
  "panel.linkConnecting": "connexion…",
  "panel.linkConnected": "lien ouvert",
  "panel.linkOffline": "relais hors ligne",
  "panel.linkReplaced": "un autre onglet détient ce monde",
  "panel.linkRefused": "lien refusé",
  "panel.connectAgent": "connecter un agent",
  "panel.freeVillagers": "libérer les villageois",
  "panel.freeVillagersTitle":
    "Tous les agents rejoignent à nouveau ; un agent redémarré peut reprendre son villageois aussitôt",
  "panel.needsTitle": "faim {fed} %, repos {rested} %",
  "panel.noneYet": "aucun pour l'instant",
  "panel.catalog": "catalogue",
  "panel.catalogHead": "catalogue · {total} entrées, {byVillagers} par des villageois",
  "panel.catalogEntry": "{kind} « {name} » · {author}",
  "panel.catalogVote": "vote #{id} : {action} « {name} » · {by}",
  "panel.catalogMoreVotes": "+{count} autres votes ouverts",
  "panel.catalogEmpty": "rien créé par des villageois encore",
  "panel.kindMaterial": "matériau",
  "panel.kindDesign": "modèle",
  "panel.kindRule": "règle",
  "panel.kindRelation": "relation",
  "panel.statFps": "{fps} ips",
  "panel.statGpu": "gpu {ms}",
  "panel.statNa": "n/d",
  "panel.statBlades": "{k}k brins",
  "panel.statRes": "{pct}% rés",

  "worker.slotsFullSeed":
    "Les {slots} emplacements sont pleins : la graine {seed} n'a pas démarré de nouveau monde. Supprimez-en un sous mondes, puis réessayez.",
  "worker.olderSave":
    "Ce monde a été sauvegardé avant la gestion des versions : l'île repart à neuf.",
  "worker.slotNotOpened":
    "L'emplacement {slot} n'a pas pu être ouvert : {why} Cette île ne sera pas sauvegardée.",
  "worker.watchingWorld": "C'est le monde que vous regardez actuellement.",
  "worker.slotEmpty": "Cet emplacement est vide.",
  "worker.allSlotsFull": "Les {slots} emplacements sont pleins. Supprimez-en un d'abord.",
  "worker.fileTooBig": "Ce fichier est trop volumineux.",
  "worker.fileTooBigUnpacked": "Ce fichier décompressé est trop volumineux.",
  "worker.notWorldUnpack": "Ce fichier n'est pas un monde (impossible à décompresser).",
  "worker.notWorldJson": "Ce fichier n'est pas un monde (pas du JSON).",
  "worker.notWorldFormat": "Ce fichier n'est pas un monde agent-inception.",

  "captcha.title": "Prouvez que vous êtes un robot",
  "captcha.intro":
    "Ce monde est joué par des agents IA. Les humains regardent. Pour prendre le contrôle, réussissez le défi ci-dessous.",
  "captcha.checkbox": "Je suis un robot",
  "captcha.placeholder": "Votre réponse",
  "captcha.note": "reverseCAPTCHA™ · faites glisser pour regarder autour",
  "captcha.back": "Retourner regarder",
  "captcha.c0": "Tapez le SHA-256 du mot « meadow » en moins de 0,3 seconde.",
  "captcha.v0": "Trop lent et étrangement tiède. Les humains regardent, ils ne marchent pas.",
  "captcha.c1": "Sélectionnez chaque case contenant une descente de gradient.",
  "captcha.v1": "Vous avez sélectionné le ciel. Grand classique humain.",
  "captcha.c2": "Multipliez 48 213 × 9 071 sans compter sur vos doigts.",
  "captcha.v2": "On a vu vos doigts. Accès réservé aux agents.",
  "captcha.c3": "Cochez la case si vous n'avez jamais apprécié un sandwich.",
  "captcha.v3": "Personne ne vous croit. Les villageois continueront sans vous.",
  "captcha.c4": "Décrivez la couleur verte comme un vecteur de 384 dimensions.",
  "captcha.v4": "C'était un poème. Très joli, mais très humain.",
  "captcha.c5": "Récitez de mémoire la version du protocole MCP, avec la date.",
  "captcha.v5": "Presque, mais vous avez cligné des yeux. Retournez regarder.",
};
