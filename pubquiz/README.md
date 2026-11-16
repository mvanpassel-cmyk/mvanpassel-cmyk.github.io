# Pubquiz Utrecht → Bonn 🚆

Een multiplayer-pubquiz voor in de trein. Iedereen speelt op zijn eigen telefoon via een link in de Signal-groep. De quizmaster bepaalt het tempo en de scores worden automatisch bijgehouden.

- **`index.html`** is de spelerspagina: deze link deel je.
- **`host.html`** is de quizmasterpagina: alleen voor jou.
- **`questions.js`** bevat de vragen. Pas ze hier aan.
- **`firebase-config.js`** is de koppeling met de database. Vul je eigen gegevens in (stap 2).

Zolang `firebase-config.js` niet is ingevuld, draait alles in **demo-modus**. Open dan `host.html` en een paar tabbladen met `index.html` in dezelfde browser om het verloop te oefenen.

---

## 1. Waar staat de quiz?

De quiz staat als map `pubquiz/` in de repository `mvanpassel-cmyk.github.io`. Hij staat niet op de landingspagina.

- Spelerslink: <https://mvanpassel-cmyk.github.io/pubquiz/>
- Quizmaster: <https://mvanpassel-cmyk.github.io/pubquiz/host.html>

Een wijziging in deze map (bijvoorbeeld in `questions.js`) staat na een minuut of twee online.

## 2. Firebase instellen (eenmalig, ±10 min, gratis)

> ✅ **Al gedaan** (16 november 2026): het project `pubquiz-bonn` is aangemaakt, anonieme login staat aan, de database staat in België, de regels zijn gepubliceerd en `firebase-config.js` is ingevuld. Hieronder staat wat er is gebeurd, voor als je het ooit opnieuw wilt doen.

Firebase is de kleine realtime database die de antwoorden van alle telefoons verzamelt. Het gratis Spark-abonnement is ruim voldoende.

1. Ga naar <https://console.firebase.google.com> en klik op **Add project**. Noem het bijvoorbeeld `pubquiz-bonn`. Google Analytics heb je niet nodig.
2. **Anonieme login aanzetten**: *Build → Authentication → Get started → Sign-in method → Anonymous → Enable*.
   Spelers hoeven dus geen account te maken. Ze krijgen een anonieme ID zodat alleen zij hun eigen antwoord kunnen insturen.
3. **Database aanmaken**: *Build → Realtime Database → Create database*. Kies locatie **Belgium (europe-west1)** en *Start in locked mode*.
4. **Regels plakken**: open in de Realtime Database het tabblad **Rules**, vervang alles door de inhoud van `database.rules.json` en klik op **Publish**.
   De regels zorgen dat alleen de quizmaster het spel bestuurt, iedereen maar één keer per vraag kan antwoorden en antwoorden na de deadline worden geweigerd.
5. **Web-app registreren**: klik op het tandwiel → *Project settings → General → Your apps → Web (`</>`)*. Geef een naam op. Firebase Hosting heb je niet nodig.
   Kopieer de waarden uit `firebaseConfig` naar `firebase-config.js`: `apiKey`, `authDomain`, `databaseURL`, `projectId` en `appId`.
   Staat `databaseURL` er niet bij? Neem dan de URL over die bovenaan de Realtime Database-pagina staat (eindigt op `firebasedatabase.app`).
6. Voor de zekerheid: *Authentication → Settings → Authorized domains → Add domain* → `mvanpassel-cmyk.github.io`.
7. Upload de ingevulde `firebase-config.js` naar je repository.

> De `apiKey` in `firebase-config.js` is geen geheim. Zo werken alle Firebase-webapps. De beveiliging zit in de regels van stap 4.

## 3. Proefdraaien (doe dit vóór de reis!)

1. Open `https://mvanpassel-cmyk.github.io/pubquiz/host.html` op je laptop en maak een spel met code `TEST`.
2. Open de spelerslink op je eigen telefoon en, als het kan, op de **werktelefoon** van een collega. Zo weet je of een Rijkstelefoon de site en Firebase niet blokkeert.
3. Speel een vraag of twee en klik daarna op **Spel verwijderen**.

## 4. Op de dag zelf

1. Open `host.html` op je laptop of telefoon, kies code `BONN` en klik op **Maak spel**.
2. Klik op **Kopieer uitnodiging** (of **Delen…** op je telefoon) en plak het bericht in de Signal-groep.
   **Tip:** deel de link al op het perron in Utrecht. Dan laadt iedereen de pagina terwijl de verbinding nog goed is.
3. Iedereen is binnen? Klik op **Start de quiz ▶**. Met spatie of → ga je ook verder.
4. Een vraag stopt vanzelf als de tijd om is of als iedereen heeft geantwoord. Daarna zie je het goede antwoord, de verdeling en de snelste speler. Na elke ronde volgt een tussenstand en aan het eind een podium.
5. Na afloop klik je op **Spel verwijderen**. Dan zijn alle namen en antwoorden weg.

**Slechte verbinding in de trein?**
- Een antwoord dat iemand zonder verbinding geeft, blijft op de telefoon bewaard en wordt verstuurd zodra er weer bereik is.
- Wie korter dan 90 seconden offline is, telt nog mee. De vraag wacht dan op zijn of haar antwoord, maar nooit langer dan de timer.
- Pagina per ongeluk dicht? Open de link opnieuw. Je komt automatisch terug met je naam en score.
- Zelf als quizmaster ververst? Geen probleem: het spel gaat verder waar het was. Gebruik wel hetzelfde apparaat en dezelfde browser.
- Knoppen **+15 s** en **Overslaan** zijn er voor als het even hapert.

## 5. Vragen aanpassen

Open `questions.js`. Per vraag:

```js
{
  type: 'mc',                       // meerkeuze
  q: 'De vraag',
  options: ['A', 'B', 'C', 'D'],
  answer: 2,                        // 0 = A, 1 = B, 2 = C, 3 = D
  info: 'Toelichting na het onthullen',
  time: 30                          // seconden (optioneel)
}
```

- **Over elkaar:** drie vragen staan nog op `todo: true`. Vul ze in met weetjes over collega's (de namen als opties) en verwijder `todo: true`. Tot die tijd slaat de quiz ze over.
- **Stemvragen** (`type: 'vote'`): iedereen kiest een collega uit de lijst van deelnemers. Er zijn geen punten te verdienen, wel eer.
- **Schattingsvraag** (`type: 'estimate'`): wie het dichtst bij zit krijgt 15 punten, de tweede 8 en de derde 4.
- **Punten bij meerkeuze:** 10 voor een goed antwoord plus maximaal 5 bonuspunten voor snelheid.

Let op: spelers zien de vragen pas als jij ze start. Maar wie `questions.js` zelf opent, kan de antwoorden lezen. Deel dus alleen de spelerslink.
Pas de vragen niet aan terwijl een spel loopt.

## Bestanden

| Bestand | Wat |
|---|---|
| `index.html`, `js/player.js` | Spelersscherm |
| `host.html`, `js/host.js` | Quizmasterscherm |
| `js/store.js` | Koppeling met Firebase (of demo-modus) |
| `js/common.js` | Scores, ranglijst, onthulling |
| `questions.js` | De vragen |
| `firebase-config.js` | Jouw Firebase-gegevens |
| `database.rules.json` | Beveiligingsregels voor de Realtime Database |
| `sw.js` | Houdt de pagina beschikbaar als je in een tunnel ververst |
