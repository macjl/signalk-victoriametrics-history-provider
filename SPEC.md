# signalk-victoriametrics-history-provider - specification technique

Statut : specification cible, implementation en cours. Le mot "doit" designe
une exigence de la premiere version. Le support effectivement disponible et
les limites provisoires sont documentes dans README.md. Les exemples de
configuration illustrent le contrat vise; ils ne sont pas tous executables.

## 1. Objectif et perimetre

Le plugin recoit les deltas Signal K, les convertit en series temporelles et
les pousse vers **un seul vmagent** par l'API Prometheus Remote Write v1.
vmagent distribue ensuite les echantillons a zero ou plusieurs destinations
Remote Write. Le plugin peut egalement exposer l'API History de Signal K en
lisant **une seule** instance VictoriaMetrics choisie explicitement.

Flux d'ecriture : `Signal K -> plugin -> vmagent -> destinations`.
Flux de lecture : `API History Signal K -> plugin -> VictoriaMetrics`.
Il n'y a ni scrape de Signal K, ni second flux de donnees vers les destinations,
ni replication a partir d'un VictoriaMetrics. vmagent ne sert jamais la lecture.

Le plugin n'effectue qu'**une souscription** Signal K, avec `sourcePolicy`
configurable en `preferred` (defaut) ou `all`. La politique `fixed` garde le
dernier update par contexte, source et path sur chaque periode. En mode `all`,
les valeurs ecartees par la priorite sont archivees, mais le plugin ne sait pas
lesquelles etaient preferees. Une evolution de Signal K pourra ulterieurement
annoter le flux `all` avec cette decision.
Important : `preferred` est le nom de la politique de souscription, pas la
preuve qu'une regle a designe un gagnant. Sans regle, ou sur un path configure
en fan-out, Signal K peut laisser passer plusieurs sources. La v1 archive alors
les valeurs effectivement recues et ne pretend pas connaitre une preference
que le serveur n'a pas calculee.

Mode lecture seule autorise : aucune destination en ecriture, aucun vmagent
necessaire. Mode ecriture seule autorise : aucune instance History en lecture.

## 2. Dependances et compatibilite

- Signal K doit exposer `app.subscriptionmanager.subscribe`, `sourcePolicy`
  et l'enregistrement `app.registerHistoryApiProvider` pour le mode lecture.
  La version minimale exacte sera figee et testee avant publication.
- Pour les conteneurs geres, utiliser de preference `signalk-container-helper`
  au-dessus de `signalk-container`. Sans runtime Docker/Podman, les modes
  binaire local et destination distante restent possibles. Le helper etant
  publie en ESM et demandant Node >= 22, le module du plugin doit etre
  compatible avec ces contraintes.
- `vmagent` accepte `/api/v1/write` et peut repeter `-remoteWrite.url` pour
  distribuer les mesures. Le plugin n'implemente pas Remote Write vers chaque
  destination lui-meme.
- Les images vmagent et VictoriaMetrics sont epinglees a des versions publiees,
  pas a `latest`. Les versions sont fixees par chaque version du plugin et ne
  sont pas configurables. Verifier la disponibilite de l'architecture cible,
  notamment ARM 32 bits/Cerbo GX, avant de proposer le mode conteneur gere.
- L'encodage Prometheus Remote Write v1 utilise des dependances protobuf et
  Snappy eprouvees; pas de codec maison. OTLP et Remote Write v2 sont hors v1.

## 3. Configuration cible

```json
{
  "ingest": {
    "contexts": "self",
    "filterMode": "none",
    "paths": [],
    "sourcePolicy": "preferred",
    "periodMs": 5000,
    "labels": { "job": "signalk-victoriametrics", "instance": "signalk-victoriametrics-<random-hex>" },
    "batch": { "maxSamples": 500, "flushMs": 1000, "maxPendingSamples": 10000 },
    "cardinalityAlert": { "maxSeriesPerPathPerDay": 100, "excludedPaths": [] }
  },
  "vmagent": {
    "mode": "managed-container",
    "queueLimitBytesPerDestination": 1073741824
  },
  "destinations": [
    {
      "id": "local",
      "kind": "victoriametrics",
      "mode": "managed-container",
      "retention": "30d",
      "write": { "enabled": true },
      "read": {
        "enabled": true,
        "limits": {
          "maxRangeDays": 30,
          "maxSeries": 500,
          "maxSamples": 200000,
          "maxResponseBytes": 33554432,
          "timeoutMs": 15000
        }
      }
    }
  ]
}
```

Les URLs des services geres sont resolues automatiquement, sans etre stockees
dans la configuration. Les versions des images sont fixees dans le plugin.

Pour utiliser des binaires deja installes au lieu des conteneurs, remplacer
les blocs correspondants par exemple par :

```json
{
  "vmagent": {
    "mode": "host-binary",
    "binaryPath": "/usr/bin/vmagent",
    "queueLimitBytesPerDestination": 1073741824
  },
  "destinations": [
    {
      "id": "local",
      "kind": "victoriametrics",
      "mode": "host-binary",
      "binaryPath": "/usr/bin/victoria-metrics",
      "retention": "30d",
      "write": { "enabled": true },
      "read": { "enabled": true }
    }
  ]
}
```

Les autres champs de la configuration restent inchanges. Une instance
distante **deja lancee** reste `mode: "remote"` et demande son URL de base; elle
n'est pas un binaire pilote par le plugin.

### 3.1 Ingestion

- L'ingestion est active des qu'au moins une destination a `write.enabled=true`.
  `ingest.enabled` n'est ni affiche ni pris en compte. Une ancienne valeur
  enregistree est ignoree puis retiree lors du prochain enregistrement.
- `contexts`: `self` (defaut) ou `all`. `self` ne prend que le bateau local;
  `all` inclut les autres contextes Signal K. `vessels.self` est remplace par
  le contexte canonique `vessels.<selfId>` avant stockage.
- `filterMode`: `none` (defaut), `blacklist` ou `whitelist`; `paths` s'applique aux
  chemins **Signal K d'origine** avant normalisation en nom de metrique. Une
  liste blanche vide est invalide. En mode `none`, les chemins restent configures
  mais n'ont aucun effet. Le reglage est dans une section avancee repliable;
  son resume indique le mode actif et le nombre de chemins. Les chemins racines d'objets autorisent
  leurs sous-champs; un champ exclu ne doit pas etre emis par accident.
- `sourcePolicy` vaut `preferred` ou `all`. En mode `all`, aucune indication de
  preference historique n'est deduite du flux brut. `periodMs` vaut 5000 par
  defaut et doit etre positif. Avec `policy: fixed`, Signal K retient le dernier
  update recu par contexte, source et path dans chaque fenetre; les updates
  intermediaires ne sont pas archives. Une source silencieuse n'est pas reecrite.
  L'ancien `minPeriodMs` est accepte comme valeur de `periodMs` jusqu'au prochain
  enregistrement; la semantique passe du premier au dernier update de la
  fenetre. La valeur zero n'est plus admise. Le batch HTTP reste necessaire
  pour regrouper les series en POST.
- `labels`: `job` et `instance` sont obligatoires, visibles et modifiables.
  Au premier demarrage, les valeurs absentes sont enregistrees une seule fois :
  `job="signalk-victoriametrics"` et
  `instance="signalk-victoriametrics-<10 caracteres hexadecimaux aleatoires>"`.
  Les valeurs deja presentes ne sont pas modifiees. D'autres labels statiques
  peuvent etre ajoutes. Deux installations dans un TSDB partage doivent avoir
  des `instance` distincts. Interdire de redefinir les labels structurels
  `__name__`, `context`, `source`, `signalk_path`, `preferred`, `value_str`,
  `signalk_leaf`, `signalk_leaf_parts` et `signalk_value_type`. Valider les
  noms/valeurs et interdire les doublons.
- Une seule souscription est utilisee, avec le `sourcePolicy` configure et
  `policy: 'fixed'`; pas de seconde souscription, pas de consultation du cache
  des sources pour deviner la preference. Le serveur envoie un snapshot cache
  lors de l'inscription : ignorer ce bootstrap, qui n'est pas une mesure
  nouvelle. La v1 doit tester que le bootstrap est identifiable dans la
  version Signal K minimale retenue (actuellement, il est emis pendant l'appel
  synchrone a `subscribe`). Ne pas utiliser un seuil de timestamp qui ferait
  perdre des deltas live retardes.
- `cardinalityAlert.maxSeriesPerPathPerDay` vaut 100 par defaut (2 a 250).
  Les combinaisons distinctes de labels sont comptees par `signalk_path` sur
  le jour UTC de reception. `excludedPaths` supprime l'alerte pour les paths
  indiques et leurs descendants, sans les exclure de l'ingestion. Aucune
  alerte ne supprime ou ne modifie une mesure.

### 3.2 vmagent et destinations

- `vmagent.mode`: `managed-container` ou `host-binary`. Dans les deux cas,
  **le plugin demarre et configure vmagent** : entree Remote Write locale,
  sorties, authentification, limite de file et repertoire persistant. En mode
  `host-binary`, l'utilisateur fournit seulement `binaryPath`, chemin absolu
  vers le binaire vmagent deja installe sur la machine (cas Cerbo GX). Le
  plugin ne telecharge pas le binaire. L'URL d'entree est determinee par le
  plugin; elle n'est pas un parametre utilisateur.
- Tout vmagent lance par le plugin scrape son propre `/metrics` sur localhost
  toutes les 15 s via un fichier `-promscrape.config` genere. Ces metriques
  partent vers toutes les destinations actives, sans option pour desactiver
  ce suivi. Le job est `signalk-vmagent`; les labels identifient le contexte
  Signal K et utilisent `ingest.labels.instance`. En mode lecture seule,
  vmagent ne demarre pas.
- `vmagent.exposeWebUi` et `destinations[*].exposeWebUi` sont faux par defaut.
  La seconde option n'est disponible que pour VictoriaMetrics geree. La webapp
  Signal K affiche un onglet par service expose, et aucun si toutes les options
  sont desactivees. Les destinations distantes ne sont jamais relayees.
  Les pages sont servies sous les routes administrateur du plugin, sans port
  supplementaire ouvert sur l'hote. Le plugin applique `-http.pathPrefix`
  uniquement aux services exposes et adapte ses URLs History, Remote Write,
  de sante et d'auto-scrape. La desactivation ferme immediatement le relais.
- `destinations`: tableau ordonne, identifiants `id` uniques. `kind` vaut
  `victoriametrics` ou `prometheus-compatible`. La seconde valeur couvre tout
  TSDB acceptant Prometheus Remote Write, pas seulement Prometheus lui-meme.
  Seul `victoriametrics` peut avoir `read.enabled=true`. Une destination doit
  servir en ecriture, en lecture ou dans les deux sens; une destination sans
  usage est refusee. Le panneau presente un choix unique d'usage plutot que
  deux cases independantes. Une destination `prometheus-compatible` est
  toujours utilisee en ecriture.
- Pour une destination `victoriametrics`, `mode` vaut `managed-container`,
  `host-binary` ou `remote`. Les deux premiers demarrent une instance
  VictoriaMetrics single-node pilotee par le plugin, depuis une image epinglee
  ou un `binaryPath` absolu fourni par l'utilisateur. `remote` designe une
  instance deja demarree, avec une URL de base unique. Une destination
  `prometheus-compatible` est toujours `remote` et ne peut pas etre lue via
  ce provider History.
- Chaque destination possede independamment `write.enabled`. Desactivee, elle
  ne figure pas dans les `-remoteWrite.url` de vmagent. Pour une destination
  `prometheus-compatible` distante, renseigner l'URL complete du recepteur
  Remote Write. Pour une VictoriaMetrics `remote`, renseigner seulement
  `destination.url` sous la forme `http(s)://hote[:port]`, sans chemin, requete
  ou identifiants. Le plugin ajoute `/api/v1/write` pour l'ecriture et utilise
  cette URL de base pour ses appels History. Une VM geree suit le meme contrat
  d'API, avec une URL resolue automatiquement.
- vmagent negocie automatiquement le protocole de sortie, y compris son
  repli vers Prometheus Remote Write pour les recepteurs non VictoriaMetrics.
  Aucun choix de protocole ni option `force*Proto` n'est expose en v1. Pour
  un vrai serveur Prometheus, son recepteur Remote Write doit etre active.
- Authentification des destinations distantes en v1 : aucune ou un couple
  Basic Auth `destination.auth` partage par l'ecriture et la lecture History.
  TLS est valide par defaut. Bearer token, CA personnalisee et identifiants
  distincts pour la lecture et l'ecriture sont differes. Les secrets sont
  rediges dans les logs/statuts. Ecrire les identifiants d'ecriture dans des
  fichiers prives sous le repertoire du plugin, accessibles au vmagent gere
  ou `host-binary`, puis utiliser ses options `*File`. Ne pas mettre de mots
  de passe dans les arguments ou URLs. Le mot de passe reste stocke dans la
  configuration Signal K du plugin, accessible aux administrateurs.
- `queueLimitBytesPerDestination` est **un seul reglage global** applique par
  `-remoteWrite.maxDiskUsagePerURL` a chaque sortie, quel que soit le mode de
  lancement de vmagent. Ce n'est pas un plafond global du disque : N sorties
  peuvent occuper environ N fois ce
  plafond. Le panneau affiche cette valeur en GiB (1 GiB = 1073741824 octets),
  tandis que la configuration et vmagent utilisent les octets. Le repertoire
  de file `-remoteWrite.tmpDataPath` est persistant.
  La valeur zero (sans limite) est refusee.
- Conserver un ordre stable des destinations dans les arguments vmagent et ne
  pas deplacer/effacer les files existantes lors d'une simple mise a jour.
  Changer une URL ou supprimer une destination peut rendre son ancienne file
  orpheline; l'interface doit avertir avant ce changement, sans suppression
  automatique des donnees.
- Si aucune destination n'a `write.enabled=true`, ne pas souscrire aux deltas,
  ne pas demarrer vmagent et masquer son onglet de configuration. Une
  VictoriaMetrics managée en lecture seule reste demarree.

### 3.3 Lecture History et retention

- Zero ou **une seule** destination VictoriaMetrics avec `read.enabled=true`.
  Le validateur de configuration interdit de cocher `read.enabled` sur deux
  destinations : dans le panneau, une fois une destination selectionnee, les
  choix d'usage avec lecture sont grises ailleurs. Une configuration editee a la main
  qui en active deux est refusee a l'enregistrement **et** au demarrage. Pas
  de selection du "premier", pas de fallback implicite. Une destination en
  lecture peut avoir `write.enabled=false`.
- Pour une VM `remote`, la lecture History utilise `destination.url` et y
  ajoute les chemins `/api/v1/export` et `/api/v1/label/...`. Les deux usages
  partagent le meme hote. Un frontal VictoriaMetrics qui exige un prefixe de
  chemin ou des hotes distincts pour la lecture et l'ecriture n'est pas pris
  en charge par ce mode. En mode gere, le plugin determine l'URL locale.
- `read.selectorLabels` est facultatif et reprend `ingest.labels` par defaut.
  Pour lire les donnees d'un **autre** producteur, l'utilisateur fournit un
  objet de labels correspondant a ce producteur. Les labels obligatoires
  `job`/`instance` isolent par defaut cette installation dans un TSDB partage.
- `read.limits` borne le travail de lecture par requete; les valeurs de
  l'exemple sont les valeurs par defaut. Les limites peuvent etre reduites ou
  augmentees explicitement, jamais desactivees. `timeoutMs` couvre l'appel VM
  et le decodage de sa reponse; les erreurs distinguent timeout et limite.
- `retention` ne s'applique qu'aux VM gerees et configure `-retentionPeriod`.
  Elle s'applique a toute l'instance VM, pas a un bateau ni a un path. En mode
  `remote`, la retention est geree par l'administrateur du TSDB. `host-binary`
  est gere et applique donc aussi ce reglage. Si le champ est absent, le plugin
  utilise `30d`; s'il est vide, il reste vide dans la configuration et le
  plugin transmet `100y` a VictoriaMetrics. C'est une approximation de la
  retention illimitee, qui n'est pas prise en charge nativement par VM. Une
  valeur explicite doit respecter le format VM et representer au moins un jour.
- Le plugin n'enregistre `registerHistoryApiProvider` que si une destination
  de lecture est configuree. Au `stop`, il se desabonne et se desenregistre.

## 4. Contrat des metriques

Le format suit `signalk-prometheus-exporter-macjl` 0.2.1 afin de faciliter
la migration et les requetes existantes :

```text
navigation_speedOverGround{context="vessels.urn:mrn:signalk:uuid:...",source="can0.device",signalk_path="navigation.speedOverGround",preferred="true",job="signalk-victoriametrics",instance="signalk-victoriametrics-a1b2c3d4e5"} 3.14 <timestamp-ms>
navigation_position_longitude{context="...",source="can0.device",signalk_path="navigation.position",signalk_leaf="navigation.position.longitude",preferred="true",job="signalk-victoriametrics",instance="signalk-victoriametrics-a1b2c3d4e5"} 17.13 <timestamp-ms>
navigation_position_latitude{context="...",source="can0.device",signalk_path="navigation.position",signalk_leaf="navigation.position.latitude",preferred="true",job="signalk-victoriametrics",instance="signalk-victoriametrics-a1b2c3d4e5"} 23.63 <timestamp-ms>
```

- `__name__` est le chemin aplati avec `.` et `-` remplaces par `_`, comme
  l'exporter; tout autre caractere non valide pour un nom Prometheus est aussi
  normalise. Le chemin Signal K original reste **toujours** dans
  `signalk_path`; aucune lecture ne le devine depuis `__name__`.
- `source` est `update.$source`, jamais le nom affiche de la connexion.
  Un update sans source exploitable est ignore et compte comme anomalie, car
  il ne peut pas etre identifie sans ambiguite dans l'historique.
- `job` et `instance` figurent sur **chaque** serie et dans les filtres de
  lecture. Une autre installation doit utiliser une valeur `instance`
  differente pour eviter de melanger ses donnees avec celles de ce plugin.
- Les feuilles d'objets ont aussi `signalk_leaf` contenant le chemin Signal K
  complet de la feuille. Cela evite qu'une normalisation identique de deux
  feuilles d'un meme objet les fusionne. Les noms de metriques et le label
  racine `signalk_path` restent compatibles avec les requetes de l'exporter.
- Les nombres finis sont des gauges; les booleens deviennent 0/1 avec
  `signalk_value_type="boolean"`; les chaines non-date deviennent une valeur 1
  avec `value_str`; les chaines-date suivent l'exporter et deviennent l'epoch
  en millisecondes avec `signalk_value_type="datetime"`. `null`, les objets et
  tableaux vides sont representes par des marqueurs types de valeur 1. NaN,
  infini et valeurs non prises en charge ne sont pas ecrits. Les objets et
  tableaux sont aplatis recursivement en feuilles avec le path racine dans
  `signalk_path`; `signalk_leaf_parts` conserve les segments des cles ambigues
  et les indices de tableaux. `navigation.position` conserve les deux feuilles
  `latitude` et `longitude`; le couple est emis dans le meme batch avec le
  meme timestamp. Ne pas ecrire un couple partiel comme position valide.
- Utiliser `update.timestamp` en millisecondes; si absent/invalide, utiliser
  l'heure de reception et compter le remplacement. Eviter de renvoyer un
  echantillon identique apres une relecture du cache ou une reprise.
- Chaque mesure du flux `preferred` porte `preferred="true"`. Ici `true`
  signifie **recu via `sourcePolicy: preferred`**, pas necessairement qu'une
  regle de priorite a selectionne une source : sans regle ou sur un path en
  fan-out, plusieurs sources peuvent toutes porter `true`. Le plugin ne peut
  pas deduire de distinction plus fine du flux actuel. Le flux `all` omet ce
  label : il ne signifie ni `true` ni `false`. La lecture accepte `true` ou
  l'absence du label pour relire les deux modes de collecte.
- Un changement de source cree une nouvelle serie `source`, mais une lecture
  sans filtre `source` reunit les valeurs recues. Des echantillons exactement
  simultanes de sources differentes contribuent tous aux agregats numeriques.
  Pour `first`, `last` et `middle_index`, seule la premiere source dans l'ordre
  lexicographique est prise a timestamp egal; cela ne designe pas une
  preference Signal K.
- Emettre une metrique de debut de session propre au plugin pour permettre aux
  alertes de distinguer les etats recus avant/apres un redemarrage. Elle ne
  remplace pas l'ancienne metrique de session de l'exporter et la migration des
  alertes doit etre explicite.

## 5. Ecriture, charge et erreurs

Le callback de souscription filtre et convertit sans I/O synchrone. Il ajoute
les echantillons a une file memoire bornee. Un seul expediteur ordonne les
lots par serie et les POST vers `vmagent /api/v1/write` (protobuf Prometheus
v1 + Snappy). `flushMs` vaut 1000 par defaut, independamment de `periodMs`,
et reste une option avancee. Les seuils `maxSamples`, `flushMs` et
`maxPendingSamples` sont configurables et valides; une limite de taille HTTP
doit aussi etre imposee.
Ce batch n'ajoute aucun deuxieme flux depuis Signal K.

Un 2xx de vmagent signifie acceptation par vmagent, **pas** persistance dans
toutes les destinations. Si vmagent est indisponible, refuse le POST ou reste
injoignable au controle de sante, le plugin passe immediatement en etat erreur
`app.setPluginError`. Il ne laisse pas croitre sa memoire : la file est bornee,
les valeurs excedentaires sont abandonnees et comptees. Une sonde reguliere
retablit automatiquement l'etat normal quand vmagent repond; les donnees de la
coupure ne sont pas rejouees par le plugin. Arreter le plugin perd pareillement
les mesures pendant l'arret. Une panne d'une destination **apres** vmagent
n'interrompt pas la collecte tant que vmagent accepte et tamponne les donnees.

Le statut du plugin expose au minimum : mode actif, etat vmagent, destination
History, dernier succes d'ecriture, debit d'echantillons, taille de la file
memoire, compteurs de pertes et de valeurs ignorees; pour vmagent lance en
conteneur ou depuis un binaire local, occupation des files par destination,
erreurs de sorties et drops. Avertir avant
qu'une file disque soit pleine; si elle atteint sa limite, signaler clairement
la perte de donnees. Les metriques `/metrics` de vmagent servent de source de
verite, pas une estimation locale. Aucun token, mot de passe ni URL contenant
des secrets ne doit apparaitre dans un message de statut.

Une derive de cardinalite declenche un avertissement visible dans le statut
du plugin, avec les paths concernes, sans interrompre les ecritures. Le suivi
memorise au plus le nombre d'empreintes requis pour atteindre le seuil par
path, sur 500 paths au maximum; si cette derniere borne est atteinte, le
statut signale que certains paths ne sont pas surveilles. Les compteurs sont
remis a zero a minuit UTC et au redemarrage. Ils ne remplacent pas les
statistiques de cardinalite de VictoriaMetrics sur les series deja stockees.

## 6. Contrat de lecture History

Le provider implemente `getValues`, `getContexts` et `getPaths` de
`@signalk/server-api/history`. Il lit les **echantillons bruts** de VM via
`/api/v1/export` (JSON lines, `match[]`, `start`, `end`), puis construit les
intervalles et agregats History. `query_range` ne sert pas de source brute :
son `step` reevalue les series et peut masquer des variations entre deux pas.
`getContexts` et `getPaths` utilisent `/api/v1/label/<name>/values` avec
`match[]`, `start`, `end` et une limite de resultats; ils ne telechargent pas
les echantillons. VictoriaMetrics arrondit ces bornes aux jours UTC : une
valeur decouverte peut ne pas avoir de mesure dans la sous-periode exacte.
Les selecteurs utilisent `signalk_path`, `context`, un matcher acceptant
`preferred="true"` ou l'absence du label, les
labels supplementaires du selecteur de lecture et, si demande, `source`.
Les valeurs de filtre sont echappees; pas de concatenation directe d'entrees
utilisateur en MetricsQL.
Les resultats sont lus en streaming, avec limites configurees sur la plage,
le nombre de series, les echantillons et la taille de reponse. Depasser une
limite produit une erreur explicite, jamais une reponse tronquee silencieuse.

- Sans source dans `PathSpec`, inclure toutes les series **stockees par ce
  plugin** pour ce path et fusionner chronologiquement les valeurs recues,
  meme si la source preferee a change. Ne jamais utiliser la source live
  actuelle pour filtrer le passe. En l'absence de regle de priorite, plusieurs
  sources peuvent contribuer au meme resultat : ce n'est pas une source
  preferee historique univoque.
- Avec `PathSpec.sourceRef`, filtrer cette source parmi les mesures archivees.
  Une source ecartee en mode de collecte `preferred` ne peut pas etre retrouvee.
- `sourcePolicy=all` retourne une colonne par source **stockee** pour chaque
  path sans filtre `sourceRef`, avec `$source` dans `values`. Les agregats sont
  calcules separement pour chaque source. Les sources ecartees lors de la
  collecte `preferred` ne peuvent pas etre restituees; `all` en lecture designe
  toutes les sources presentes dans l'historique du provider. Un filtre
  `sourceRef` explicite reste prioritaire et ne cree qu'une colonne. Les series
  historiques sans label `source` restent lisibles dans une colonne sans
  `$source`, sans provoquer d'erreur.
- `navigation.position` est reconstruit a partir du couple longitude/latitude
  de la meme source et du meme timestamp, puis retourne `[longitude, latitude]`
  (ordre GeoJSON). Un couple incomplet retourne `null`, jamais une position
  hybride de deux sources ou de deux instants.
- Les intervalles suivent `from`, `to`, `duration`, `resolution` de l'API
  History. Avec `resolution`, regrouper les echantillons en buckets
  `[from+n*resolution, from+(n+1)*resolution)` et n'emettre que les buckets
  ayant au moins une mesure; sans `resolution`, retourner les timestamps
  bruts dans la limite configuree. Les lignes sont triees et les colonnes
  suivent l'ordre des `pathSpecs`; une case sans donnee est `null`.
- Pour les scalaires numeriques, la v1 implemente `average`, `min`, `max`,
  `first`, `last`, `mid` et `middle_index`; `sma` et `ema` sont refusees avec
  une erreur explicite. Pour les angles en radians, `average` est circulaire.
  Pour `navigation.position`, seules `first`, `last` et `middle_index` sont
  prises en charge en v1; la moyenne d'une position n'est pas la moyenne
  independante des coordonnees. Les autres methodes sont refusees, jamais
  remplacees silencieusement.
- Les chaines, booleens et objets JSON sont restitues dans leur type d'origine.
  Les feuilles d'un objet sont regroupees uniquement si elles ont le meme
  timestamp et la meme source. `first`, `last` et `middle_index` selectionnent
  une valeur dans un bucket. Signal K demande `average` par defaut, sans
  connaitre le type du path. Si un path contient des valeurs non numeriques,
  le provider applique `last` a toute la colonne et annonce `method: last`
  dans la reponse, meme si `average` etait explicitement demande. Les paths
  exclusivement numeriques conservent `average`. `min`, `max` et `mid`
  restent reserves aux valeurs numeriques.
- `getContexts` et `getPaths` sont bornes par les jours UTC contenant la
  periode demandee et par les labels du selecteur de lecture. Sans labels distinctifs dans un TSDB
  partage, ils peuvent remonter les series d'autres producteurs : c'est une
  limite explicite de la configuration, pas un filtrage implicite.
- Une VM de lecture indisponible produit une erreur History claire et un
  statut plugin en erreur; aucune bascule vers une autre VM n'est tentee.

Les anciennes series booleennes et chaines-date ecrites sans
`signalk_value_type` restent numeriques : leur type original ne peut pas etre
deduit des labels deja stockes. Les series d'objets numeriques ecrites avec
`signalk_leaf` sont relues sans migration. Une feuille absente ne peut pas etre
reconstituee et ne doit jamais etre empruntee a une autre source ou un autre
timestamp.

## 7. Gestion des conteneurs et stockage

Pour `managed-container`, utiliser de preference `signalk-container-helper`
pour la decouverte du gestionnaire, le cycle de vie, la disponibilite et le
nettoyage; n'appeler directement `signalk-container` que pour une capacite non
couverte par le helper, telle que la resolution d'un chemin hote si necessaire.
Le helper doit permettre `ensureRunning`, l'adresse accessible depuis Signal K
et l'arret des conteneurs appartenant au plugin. Les noms sont stables et
propres au plugin. Ne pas exposer 8428/8429 sur toutes les interfaces sans
demande explicite.

En mode `host-binary`, verifier le `binaryPath` absolu, executable et de
version compatible, puis lancer vmagent/VM comme processus enfants **sans
shell** avec les memes options que le mode conteneur : URLs et port d'ecoute
locaux, destinations, authentification et repertoire de donnees. Surveiller
leur vie, signaler une sortie inattendue, et arreter uniquement les processus
demarres par ce plugin. Le binaire fourni n'est ni modifie ni supprime.
Ce mode exige que le processus Signal K puisse executer directement le
binaire : si Signal K tourne dans un conteneur sans acces au binaire dans son
propre espace de fichiers/processus, refuser cette configuration. Un simple
chemin present sur l'hote physique ne suffit pas dans ce cas.

Les combinaisons mixtes exigent un test de connexion au demarrage. Un vmagent
`host-binary` atteint une VM en conteneur par l'adresse publiee par
`signalk-container`. Inversement, un vmagent en conteneur ne peut pas joindre
une VM `host-binary` sur le `127.0.0.1` **du conteneur** : le plugin doit
resoudre une adresse de l'hote joignable depuis ce conteneur et restreindre
l'exposition du port VM au reseau necessaire. Si ce trajet ne peut pas etre
etabli sans exposition non voulue, la configuration est refusee avec une
explication; ne pas annoncer cette combinaison comme fonctionnelle sans test.

Les donnees persistantes (vmagent et VM geres) et les fichiers de secrets
resident sous `app.getDataDirPath()`. Quand Signal K tourne lui-meme en
conteneur, traduire les chemins pour l'hote via l'API de
`signalk-container` (`resolveHostPath`) : monter le chemin interne brut du
conteneur Signal K dans un autre conteneur est incorrect. Ne jamais supprimer
les donnees VM ni les files vmagent lors d'un `stop` ou d'une mise a jour du
plugin. La suppression definitive exige une action explicite et separee.

Les modes sont independants : vmagent en conteneur ou binaire local, VM en
conteneur, binaire local ou distante. Une VM geree peut etre en lecture seule;
un TSDB compatible Prometheus distant peut etre une sortie ecriture seule.

## 8. Migration depuis l'exporter Prometheus

1. Relever les chemins inclus/exclus, les contextes, les labels existants,
   les dashboards, les regles d'alerte et la retention actuels.
2. Verifier les labels `job` et `instance` crees au premier demarrage ou
   conserver les valeurs deja configurees pour ce Signal K.
   Les noms de metriques et `signalk_path` restent proches de l'exporter,
   mais la cadence change : push evenementiel au lieu de scrape periodique.
3. Avec VictoriaMetrics deja demarre, configurer cette instance en mode
   `remote`, en ecriture et eventuellement en lecture. Si seul son binaire est
   installe sur l'hote, utiliser `host-binary` et laisser le plugin le piloter.
   Avec Prometheus, activer son recepteur Remote Write et le configurer comme
   destination `prometheus-compatible` distante; il ne devient pas pour autant
   une destination History de ce plugin.
4. Si le TSDB ne sait que scraper, conserver l'ancien exporter : pas de
   migration transparente. L'historique ancien n'est pas reimporte ni
   retroactivement corrige. Ne pas supposer que `preferred="true"` isole les
   nouvelles series : l'ancien exporter pouvait aussi emettre ce label.
   Eviter d'ecrire simultanement les deux flux sous les memes labels. Un
   changement de `job` ou `instance` masque les series anterieures a la
   lecture History par defaut, sans supprimer les donnees du TSDB.
5. Comparer les series pendant une courte phase de validation avec des labels
   d'instance distincts, puis arreter l'ancien exporter si le TSDB recoit le
   nouveau flux. Adapter les alertes basees sur la metrique de session.

Ce plugin ne remplace pas `signalk-history-prometheus-provider` pour lire un
Prometheus existant. La lecture accepte `preferred="true"` ou son absence,
et filtre aussi les labels
supplementaires choisis, mais **ne sait pas distinguer** ses mesures de celles
de l'ancien exporter si elles ont les memes labels. Il faut isoler les flux
par configuration ou utiliser une VM dediee. Aucune migration implicite des
anciennes series n'est promise.

## 9. Validation et criteres d'acceptation

- Tests unitaires : filtre sur path d'origine, contextes, labels reserves,
  normalisation, valeurs nulles/non finies, flattening, position, timestamps,
  collisions de serie, batch et file bornee.
- Tests de contrat : un seul abonnement `fixed`, en collecte `preferred` ou
  `all`; dernier update par source et periode; snapshot initial ignore;
  plusieurs sources sans regle restent possibles; changement de source lisible
  sans consulter la preference live; filtre `sourceRef`; `sourcePolicy=all`
  separe les sources stockees sans changer la collecte; label `preferred="true"`
  seulement pour le flux `preferred`;
  `job`/`instance` presents et stables apres le premier demarrage.
- Tests de cardinalite : serie repetee comptee une fois, seuil 100 par
  defaut, exemption sans effet sur l'ingestion, remise a zero UTC, memoire
  bornee et avertissement si la borne de paths suivis est atteinte.
- Tests History : series brutes et agregats, angles, position et couple
  incomplet, ordre des colonnes, limites de requete, isolation par labels,
  panne VM et erreur explicite.
- Tests vmagent : POST Remote Write valide, N sorties, auto-negociation du
  protocole, tampon disque persistant, coupure/reprise d'une sortie, vmagent
  indisponible => erreur plugin et pertes comptees, file saturee => alerte.
- Matrice de deploiement : Signal K natif et conteneurise; Docker et Podman
  selon disponibilite; vmagent en conteneur ou binaire local, VM en conteneur,
  binaire local ou distante; ARM32/Cerbo GX avec binaires disponibles. Tester
  le refus clair de `host-binary` inaccessible depuis Signal K conteneurise et
  le routage des deux combinaisons mixtes vmagent/VM.
- Tests de configuration : deux destinations `read.enabled=true` refusees a
  l'enregistrement et au demarrage; panneau grisant les autres choix de lecture
  des qu'une VM est selectionnee; aucun choix de protocole force en v1.
- Sandbox : injecter des deltas chiffres et `navigation.position`, interroger
  `/signalk/v2/api/history/{values,paths,contexts}`, controler les echantillons
  bruts dans VM et les compteurs de vmagent, puis interrompre/reprendre une
  destination distante sans interrompre le flux local.

## 10. References techniques

- [Signal K : contrat History](https://github.com/SignalK/signalk-server/blob/master/packages/server-api/src/history.ts)
- [Signal K : souscriptions](https://github.com/SignalK/signalk-server/blob/master/packages/server-api/src/subscriptionmanager.ts)
- [Exporter existant et format des metriques](https://github.com/macjl/signalk-prometheus-exporter-macjl)
- [vmagent : entree Remote Write, sorties et file disque](https://docs.victoriametrics.com/vmagent/)
- [VictoriaMetrics : export d'echantillons bruts](https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/#how-to-export-time-series)
- [Prometheus Remote Write 1.0](https://prometheus.io/docs/specs/prw/remote_write_spec/)
- [signalk-container : API pour plugins](https://github.com/dirkwa/signalk-container/blob/master/doc/plugin-developer-guide.md)
- [signalk-container-helper : paquet et API](https://www.npmjs.com/package/signalk-container-helper)
