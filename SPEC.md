# signalk-victoriametrics-history-provider - specification technique

Statut : specification pour revue, avant implementation. Le mot "doit" designe
une exigence de la premiere version. Les exemples de configuration illustrent
le contrat vise; ils ne sont pas encore une configuration executable.

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

En v1, le plugin n'effectue qu'**une souscription** Signal K, avec
`sourcePolicy: 'preferred'`. Il archive uniquement les valeurs transmises par
le filtre de priorite du serveur au moment de leur emission. Il ne reconstitue
pas les sources ecartees. C'est une regression volontaire par rapport au mode
`all` de `signalk-prometheus-exporter-macjl`. Une evolution de Signal K pourra
ulterieurement annoter chaque valeur du flux `all` avec sa decision de priorite;
le support de toutes les sources sera alors une evolution distincte du plugin.
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
  pas a `latest`. Verifier la disponibilite de l'architecture cible, notamment
  ARM 32 bits/Cerbo GX, avant de proposer le mode conteneur gere.
- L'encodage Prometheus Remote Write v1 utilise des dependances protobuf et
  Snappy eprouvees; pas de codec maison. OTLP et Remote Write v2 sont hors v1.

## 3. Configuration cible

```json
{
  "ingest": {
    "enabled": true,
    "contexts": "self",
    "filterMode": "blacklist",
    "paths": [],
    "minPeriodMs": 0,
    "labels": {},
    "batch": { "maxSamples": 500, "flushMs": 200, "maxPendingSamples": 10000 }
  },
  "vmagent": {
    "mode": "managed-container",
    "imageTag": "<version-verifiee>",
    "queueLimitBytesPerDestination": 1073741824
  },
  "destinations": [
    {
      "id": "local",
      "kind": "victoriametrics",
      "mode": "managed-container",
      "imageTag": "<version-verifiee>",
      "retention": "30d",
      "write": { "enabled": true, "url": "auto" },
      "read": {
        "enabled": true,
        "url": "auto",
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

Les valeurs `auto` et `<version-verifiee>` sont des intentions de schema, pas
des valeurs a transmettre telles quelles aux processus. L'interface devra
afficher les URLs resolues, sans afficher les secrets.

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
      "write": { "enabled": true, "url": "auto" },
      "read": { "enabled": true, "url": "auto" }
    }
  ]
}
```

Les autres champs de la configuration restent inchanges. Une instance
distante **deja lancee** reste `mode: "remote"` et demande des URLs; elle
n'est pas un binaire pilote par le plugin.

### 3.1 Ingestion

- `contexts`: `self` (defaut) ou `all`. `self` ne prend que le bateau local;
  `all` inclut les autres contextes Signal K. `vessels.self` est remplace par
  le contexte canonique `vessels.<selfId>` avant stockage.
- `filterMode`: `blacklist` (defaut) ou `whitelist`; `paths` s'applique aux
  chemins **Signal K d'origine** avant normalisation en nom de metrique. Une
  liste blanche vide est invalide. Les chemins racines d'objets autorisent
  leurs sous-champs; un champ exclu ne doit pas etre emis par accident.
- `minPeriodMs=0` signifie ne pas demander de reduction de frequence a Signal K.
  Une valeur positive utilise le `minPeriod` de la souscription et peut perdre
  des etats intermediaires. Le batch HTTP reste necessaire : le reglage de
  souscription ne regroupe pas les mesures de toutes les series en un seul POST.
- `labels`: labels statiques supplementaires, definis uniquement par
  l'utilisateur; objet vide par defaut. `job` et `instance` ne sont ni imposes
  ni pre-remplis : l'utilisateur peut les ajouter pour retrouver son ancienne
  organisation Prometheus. Quand plusieurs Signal K ecrivent dans un meme
  TSDB, il doit choisir au moins un label distinctif par installation (par
  exemple `instance`). Interdire de redefinir les labels structurels
  `__name__`, `context`, `source`, `signalk_path`, `preferred`, `value_str` et
  `signalk_leaf`. Valider les noms/valeurs et interdire les doublons.
- Une seule souscription est utilisee, avec `sourcePolicy: 'preferred'` et
  `policy: 'instant'`; pas de souscription `all`, pas de consultation du cache
  des sources pour deviner la preference. Le serveur envoie un snapshot cache
  lors de l'inscription : ignorer ce bootstrap, qui n'est pas une mesure
  nouvelle. La v1 doit tester que le bootstrap est identifiable dans la
  version Signal K minimale retenue (actuellement, il est emis pendant l'appel
  synchrone a `subscribe`). Ne pas utiliser un seuil de timestamp qui ferait
  perdre des deltas live retardes.

### 3.2 vmagent et destinations

- `vmagent.mode`: `managed-container` ou `host-binary`. Dans les deux cas,
  **le plugin demarre et configure vmagent** : entree Remote Write locale,
  sorties, authentification, limite de file et repertoire persistant. En mode
  `host-binary`, l'utilisateur fournit seulement `binaryPath`, chemin absolu
  vers le binaire vmagent deja installe sur la machine (cas Cerbo GX). Le
  plugin ne telecharge pas le binaire. L'URL d'entree est determinee par le
  plugin; elle n'est pas un parametre utilisateur.
- `destinations`: tableau ordonne, identifiants `id` uniques. `kind` vaut
  `victoriametrics` ou `prometheus-compatible`. La seconde valeur couvre tout
  TSDB acceptant Prometheus Remote Write, pas seulement Prometheus lui-meme.
  Seul `victoriametrics` peut avoir `read.enabled=true`.
- Pour une destination `victoriametrics`, `mode` vaut `managed-container`,
  `host-binary` ou `remote`. Les deux premiers demarrent une instance
  VictoriaMetrics single-node pilotee par le plugin, depuis une image epinglee
  ou un `binaryPath` absolu fourni par l'utilisateur. `remote` designe une
  instance deja demarree, avec ses URLs de lecture/ecriture. Une destination
  `prometheus-compatible` est toujours `remote` et ne peut pas etre lue via
  ce provider History.
- Chaque destination possede independamment `write.enabled`. Desactivee, elle
  ne figure pas dans les `-remoteWrite.url` de vmagent. Pour une destination
  `remote`, renseigner l'URL complete du recepteur Remote Write, pas une simple
  URL racine. Pour une VM geree, le plugin construit `/api/v1/write`.
- vmagent negocie automatiquement le protocole de sortie, y compris son
  repli vers Prometheus Remote Write pour les recepteurs non VictoriaMetrics.
  Aucun choix de protocole ni option `force*Proto` n'est expose en v1. Pour
  un vrai serveur Prometheus, son recepteur Remote Write doit etre active.
- Authentification des destinations distantes : aucune, Basic Auth ou bearer
  token; TLS valide par defaut, CA personnalisee possible. Les secrets sont
  rediges dans les logs/statuts. Ecrire les secrets dans des fichiers prives
  sous le repertoire du plugin : les monter en lecture seule dans un vmagent
  conteneurise ou les passer par chemin local au vmagent `host-binary`, puis
  utiliser ses options `*File`. Ne pas mettre de mots de passe dans les
  arguments ou URLs.
- `queueLimitBytesPerDestination` est **un seul reglage global** applique par
  `-remoteWrite.maxDiskUsagePerURL` a chaque sortie, quel que soit le mode de
  lancement de vmagent. Ce n'est pas un plafond global du disque : N sorties
  peuvent occuper environ N fois ce
  plafond. Le repertoire de file `-remoteWrite.tmpDataPath` est persistant.
  La valeur zero (sans limite) est refusee.
- Conserver un ordre stable des destinations dans les arguments vmagent et ne
  pas deplacer/effacer les files existantes lors d'une simple mise a jour.
  Changer une URL ou supprimer une destination peut rendre son ancienne file
  orpheline; l'interface doit avertir avant ce changement, sans suppression
  automatique des donnees.
- Si aucune destination n'a `write.enabled=true`, ne pas souscrire aux deltas,
  ne pas demarrer vmagent et ne pas accepter `ingest.enabled=true`.

### 3.3 Lecture History et retention

- Zero ou **une seule** destination VictoriaMetrics avec `read.enabled=true`.
  Le validateur de configuration interdit de cocher `read.enabled` sur deux
  destinations : dans le panneau, une fois une destination selectionnee, les
  autres controles de lecture sont grises. Une configuration editee a la main
  qui en active deux est refusee a l'enregistrement **et** au demarrage. Pas
  de selection du "premier", pas de fallback implicite. Une destination en
  lecture peut avoir `write.enabled=false`.
- `read.url` est l'URL de requete VictoriaMetrics (pour une VM geree, resolue
  automatiquement). Une VM `remote` peut etre une instance single-node ou un
  frontal `vmselect` compatible avec les endpoints documentes; son URL de
  lecture peut differer de celle d'ecriture. En mode `host-binary`, le plugin
  determine l'URL locale du processus qu'il demarre.
- `read.selectorLabels` est facultatif et reprend `ingest.labels` par defaut.
  Pour lire les donnees d'un **autre** producteur, l'utilisateur fournit un
  objet de labels correspondant a ce producteur. Sans labels supplementaires,
  la lecture ne peut pas distinguer deux producteurs ayant les memes
  `context`, `signalk_path` et `source` dans un TSDB partage; la configuration
  doit afficher cet avertissement, sans inventer de label `job` ou `instance`.
- `read.limits` borne le travail de lecture par requete; les valeurs de
  l'exemple sont les valeurs par defaut. Les limites peuvent etre reduites ou
  augmentees explicitement, jamais desactivees. `timeoutMs` couvre l'appel VM
  et le decodage de sa reponse; les erreurs distinguent timeout et limite.
- `retention` ne s'applique qu'aux VM gerees et configure `-retentionPeriod`.
  Elle s'applique a toute l'instance VM, pas a un bateau ni a un path. En mode
  `remote`, la retention est geree par l'administrateur du TSDB. `host-binary`
  est gere et applique donc aussi ce reglage.
- Le plugin n'enregistre `registerHistoryApiProvider` que si une destination
  de lecture est configuree. Au `stop`, il se desabonne et se desenregistre.

## 4. Contrat des metriques

Le format suit `signalk-prometheus-exporter-macjl` 0.2.1 afin de faciliter
la migration et les requetes existantes :

```text
navigation_speedOverGround{context="vessels.urn:mrn:signalk:uuid:...",source="can0.device",signalk_path="navigation.speedOverGround",preferred="true"} 3.14 <timestamp-ms>
navigation_position_longitude{context="...",source="can0.device",signalk_path="navigation.position",signalk_leaf="navigation.position.longitude",preferred="true"} 17.13 <timestamp-ms>
navigation_position_latitude{context="...",source="can0.device",signalk_path="navigation.position",signalk_leaf="navigation.position.latitude",preferred="true"} 23.63 <timestamp-ms>
```

- `__name__` est le chemin aplati avec `.` et `-` remplaces par `_`, comme
  l'exporter; tout autre caractere non valide pour un nom Prometheus est aussi
  normalise. Le chemin Signal K original reste **toujours** dans
  `signalk_path`; aucune lecture ne le devine depuis `__name__`.
- `source` est `update.$source`, jamais le nom affiche de la connexion.
  Un update sans source exploitable est ignore et compte comme anomalie, car
  il ne peut pas etre identifie sans ambiguite dans l'historique.
- Aucun label supplementaire n'est ajoute d'office pour `job`, `instance` ou
  l'identite du plugin. Si l'utilisateur les configure, ils figurent sur
  **chaque** serie et dans les filtres de lecture. Dans un TSDB partage, des
  labels identiques ou absents peuvent melanger les producteurs, y compris
  l'ancien exporter; il faut des labels distinctifs explicites pour les isoler.
- Les feuilles d'objets ont aussi `signalk_leaf` contenant le chemin Signal K
  complet de la feuille. Cela evite qu'une normalisation identique de deux
  feuilles d'un meme objet les fusionne. Les noms de metriques et le label
  racine `signalk_path` restent compatibles avec les requetes de l'exporter.
- Les nombres finis sont des gauges; les booleens deviennent 0/1; les chaines
  non-date deviennent une valeur 1 avec `value_str`; les chaines-date suivent
  l'exporter et deviennent l'epoch en millisecondes. `null`, NaN, infini et
  valeurs non prises en charge ne sont pas ecrits. Les objets sont aplatis
  recursivement en feuilles numeriques, booleennes ou chaines, avec le path
  racine dans `signalk_path`. `navigation.position` conserve les deux feuilles
  `latitude` et `longitude`; le couple est emis dans le meme batch avec le
  meme timestamp. Ne pas ecrire un couple partiel comme position valide.
- Utiliser `update.timestamp` en millisecondes; si absent/invalide, utiliser
  l'heure de reception et compter le remplacement. Eviter de renvoyer un
  echantillon identique apres une relecture du cache ou une reprise.
- Chaque mesure ecrite porte `preferred="true"` pour faciliter une future
  extension aux sources ecartees et les requetes sur ce flux. Ici `true`
  signifie **recu via `sourcePolicy: preferred`**, pas necessairement qu'une
  regle de priorite a selectionne une source : sans regle ou sur un path en
  fan-out, plusieurs sources peuvent toutes porter `true`. Le plugin ne peut
  pas deduire de distinction plus fine du flux actuel.
- Un changement de source preferee cree une nouvelle serie `source`, mais une
  lecture sans filtre `source` reconstitue la suite temporelle des valeurs
  recues. Des echantillons exactement simultanes entre sources sont resolus
  par ordre lexicographique de `$source` (premier gagne), et comptes comme
  collision. Cette regle assure le determinisme; elle ne designe pas une
  preference quand Signal K n'en a pas designe.
- Emettre une metrique de debut de session propre au plugin pour permettre aux
  alertes de distinguer les etats recus avant/apres un redemarrage. Elle ne
  remplace pas l'ancienne metrique de session de l'exporter et la migration des
  alertes doit etre explicite.

## 5. Ecriture, charge et erreurs

Le callback de souscription filtre et convertit sans I/O synchrone. Il ajoute
les echantillons a une file memoire bornee. Un seul expediteur ordonne les
lots par serie et les POST vers `vmagent /api/v1/write` (protobuf Prometheus
v1 + Snappy). Les seuils `maxSamples`, `flushMs` et `maxPendingSamples` sont
configurables et valides; une limite de taille HTTP doit aussi etre imposee.
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

## 6. Contrat de lecture History

Le provider implemente `getValues`, `getContexts` et `getPaths` de
`@signalk/server-api/history`. Il lit les **echantillons bruts** de VM via
`/api/v1/export` (JSON lines, `match[]`, `start`, `end`), puis construit les
intervalles et agregats History. `query_range` ne sert pas de source brute :
son `step` reevalue les series et peut masquer des variations entre deux pas.
Les selecteurs utilisent `signalk_path`, `context`, `preferred="true"`, les
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
- Avec `PathSpec.sourceRef`, filtrer cette source parmi les seules mesures
  historiquement recues via la politique `preferred`. Cela **ne** retrouve pas
  une source ecartee par une regle de priorite.
- `sourcePolicy=all` est refuse avec un message explicite indiquant que cette
  version n'archive que les valeurs preferees. Ne pas pretendre retourner
  toutes les sources. Le serveur transmet l'erreur du provider en HTTP 400.
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
- `getContexts` et `getPaths` sont bornes par la periode demandee et par les
  labels du selecteur de lecture. Sans labels distinctifs dans un TSDB
  partage, ils peuvent remonter les series d'autres producteurs : c'est une
  limite explicite de la configuration, pas un filtrage implicite.
- Une VM de lecture indisponible produit une erreur History claire et un
  statut plugin en erreur; aucune bascule vers une autre VM n'est tentee.

La lecture numerique et `navigation.position` sont obligatoires. Les series
`value_str`, les booleens et les objets generiques peuvent etre ecrits mais
leur restitution **typee** n'est pas garantie sans un contrat additionnel de
type; la v1 doit documenter/rejeter les combinaisons qu'elle ne peut pas
reconstruire fidelement, plutot que fabriquer une valeur trompeuse.

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
2. Definir explicitement les labels statiques necessaires pour identifier ce
   Signal K sans collision, par exemple `job` et `instance` si ces labels
   etaient utilises auparavant. Aucun n'est ajoute par defaut.
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
   Eviter d'ecrire simultanement les deux flux sous les memes labels.
5. Comparer les series pendant une courte phase de validation avec des labels
   d'instance distincts, puis arreter l'ancien exporter si le TSDB recoit le
   nouveau flux. Adapter les alertes basees sur la metrique de session.

Ce plugin ne remplace pas `signalk-history-prometheus-provider` pour lire un
Prometheus existant. La lecture filtre `preferred="true"` et les labels
supplementaires choisis, mais **ne sait pas distinguer** ses mesures de celles
de l'ancien exporter si elles ont les memes labels. Il faut isoler les flux
par configuration ou utiliser une VM dediee. Aucune migration implicite des
anciennes series n'est promise.

## 9. Validation et criteres d'acceptation

- Tests unitaires : filtre sur path d'origine, contextes, labels reserves,
  normalisation, valeurs nulles/non finies, flattening, position, timestamps,
  collisions de serie, batch et file bornee.
- Tests de contrat : un seul abonnement `preferred`; aucun abonnement `all`;
  aucune mesure ecartee par le serveur stockee; snapshot initial ignore;
  plusieurs sources sans regle restent possibles; changement de source lisible
  sans consulter la preference live; filtre `sourceRef`; refus de
  `sourcePolicy=all`; label `preferred="true"` sur chaque mesure Signal K;
  aucun `job`/`instance` ajoute quand `ingest.labels` est vide.
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
