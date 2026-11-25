/* Vragen voor de pubquiz. Alleen de quizmasterpagina laadt dit bestand;
   spelers krijgen een vraag pas te zien als jij hem start.

   Soorten vragen:
   - mc:       meerkeuze. "answer" is de positie van het goede antwoord: 0 = A, 1 = B, 2 = C, 3 = D.
               Goed = 10 punten + max. 5 snelheidsbonus.
   - vote:     "Wie van ons…?". Iedereen stemt op een collega, geen punten.
   - estimate: schattingsvraag. Dichtstbij = 15, tweede = 8, derde = 4 punten.

   "time" = seconden om te antwoorden (standaard: defaultTime).
   "todo: true" = nog niet ingevuld; zulke vragen slaat de quiz automatisch over. */

window.QUIZ = {
  title: 'Pubquiz Utrecht → Bonn',
  subtitle: 'VWS Internationale Zaken · donderdag 26 november 2026',
  defaultTime: 30,

  rounds: [
    {
      title: 'Actualiteiten', emoji: '📰',
      questions: [
        {
          type: 'mc',
          q: 'Het VN-klimaatsecretariaat (UNFCCC) zit in Bonn. Maar waar werd deze maand (9–20 november) de klimaattop COP31 gehouden?',
          options: ['Belém', 'Antalya', 'Adelaide', 'Bakoe'],
          answer: 1,
          info: 'Turkije was gastland en voorzitter, Australië leidde de onderhandelingen. Bakoe was COP29 (2024), Belém COP30 (2025).'
        },
        {
          type: 'mc',
          q: 'Op vrijdag 20 november kwam Tata Steel IJmuiden voor het eerst voor de rechter in een strafzaak. Waarvan verdenkt het Openbaar Ministerie het bedrijf onder meer?',
          options: ['Opzettelijk schadelijke stoffen in de lucht brengen', 'Prijsafspraken met concurrenten', 'Omkoping van ambtenaren', 'Illegale lozing van radioactief afval'],
          answer: 0,
          info: 'Het was een voorbereidende zitting bij de rechtbank in Amsterdam. De zaak begon met een aangifte namens ruim 800 omwonenden, vanwege mogelijke gezondheidsschade.'
        },
        {
          type: 'mc',
          q: 'Onderzoekers van Maastricht University wonnen vorig jaar de Ig Nobel-vredesprijs, voor onderzoek dat precies bij deze treinreis past. Wat toonden ze aan?',
          options: ['Duitsers spreken na een paar drankjes beter Nederlands', 'Nederlanders spreken na een paar drankjes beter Duits', 'Glühwein verlaagt de bloeddruk van treinreizigers', 'Wachten op een vertraagde trein maakt Nederlanders humeuriger'],
          answer: 0,
          info: 'Ze testten 50 Duitsers van in de twintig: na een paar drankjes werd hun Nederlands beter beoordeeld. Een soort Dutch courage dus. Andere Ig Nobels dat jaar: de groeisnelheid van vingernagels en de vliegkunst van dronken vleermuizen.'
        },
        {
          type: 'mc',
          q: 'Voor 2027 rekent het kabinet met een gemiddelde premie voor de basisverzekering van ongeveer…',
          options: ['€ 145 per maand', '€ 157 per maand', '€ 169 per maand', '€ 185 per maand'],
          answer: 2,
          info: 'Dat is ruim € 12 per maand meer dan in 2026. De verzekeraars zitten er gemiddeld iets boven; de maximale zorgtoeslag voor alleenstaanden wordt € 140 per maand.'
        },
        {
          type: 'mc',
          q: 'Oranje haalde op het WK 2026 de achtste finales niet, maar won tóch een prijs. Welke?',
          options: ['De Fair Play-prijs', 'De prijs voor het mooiste doelpunt', 'De prijs voor beste jonge speler', 'De Gouden Handschoen'],
          answer: 0,
          info: 'Wereldkampioen werd Spanje: 1-0 na verlenging tegen Argentinië, met een goal van Ferran Torres.'
        },
        {
          type: 'mc',
          q: 'Op maandag 16 november won Duitsland met 5-0 van Oranje in Berlijn (Nations League). Wie is bondscoach van Duitsland?',
          options: ['Julian Nagelsmann', 'Jürgen Klopp', 'Hansi Flick', 'Thomas Tuchel'],
          answer: 1,
          info: 'Klopp is pas zes wedstrijden bondscoach. Florian Wirtz scoorde twee keer. Het was de grootste Duitse zege op Nederland sinds 1959, en de eerste nederlaag van Oranje onder Xavi Hernandez.'
        },
        {
          type: 'mc',
          q: 'Tesla kondigde op 16 november een investering van € 3 miljard aan in de fabriek bij Berlijn (Grünheide). Wat moet daar vanaf 2029 van de band rollen?',
          options: ['De Cybercab: een robotaxi zonder stuur en pedalen', 'Batterijen voor huisopslag', 'De Cybertruck voor Europa', 'Humanoïde Optimus-robots'],
          answer: 0,
          info: 'Tot een miljoen per jaar. De bouw start in de eerste helft van 2027. In de EU is de Cybercab nog niet toegelaten, en Duitse autobouwers schrappen juist banen.'
        },
        {
          type: 'mc',
          q: 'Duitsland krijgt een suikertaks op sterk gezoete dranken. Half november besloot de coalitie over de begroting 2027 wanneer die ingaat. Wanneer wordt dat?',
          options: ['1 juli 2027', '1 januari 2028', '1 januari 2027', '1 januari 2030'],
          answer: 1,
          info: 'De taks zou eerst op 1 juli 2027 ingaan en schuift een half jaar op. Invoering gebeurt in drie stappen. Gezondheidsorganisaties en zorgverzekeraars hadden liever niet gewacht.'
        }
      ]
    },

    {
      title: 'Gezondheid', emoji: '🩺',
      questions: [
        {
          type: 'mc',
          q: 'De Nobelprijs voor de Geneeskunde 2026 ging naar twee Duitsers en een Amerikaan. Waarvoor?',
          options: ['mRNA-vaccins', 'Optogenetica: zenuwcellen aan- en uitzetten met licht', 'CRISPR-genbewerking', 'De ontdekking van het darmmicrobioom'],
          answer: 1,
          info: 'Peter Hegemann, Georg Nagel en Karl Deisseroth. Het begon met lichtgevoelige eiwitten uit algen.'
        },
        {
          type: 'mc',
          q: 'In 1883 voerde Duitsland als eerste land ter wereld iets in waar het BAS vandaag nog toezicht op houdt. Wat?',
          options: ['Een wettelijke ziektekostenverzekering voor arbeiders', 'Het eigen risico', 'De huisartsenpost', 'Een landelijk vaccinatieprogramma'],
          answer: 0,
          info: 'Bismarcks Krankenversicherungsgesetz. Nederland kreeg pas op 1 november 1941 een verplichte ziekenfondsverzekering, ingevoerd door de Duitse bezetter.'
        },
        {
          type: 'mc',
          q: 'Hoeveel wettelijke ziekenfondsen (Krankenkassen) had Duitsland op 1 januari 2026?',
          options: ['13', '93', '393', '1.815'],
          answer: 1,
          info: 'In 1970 waren het er nog 1.815. Het BAS houdt toezicht op de kassen die in meer dan drie deelstaten actief zijn.'
        },
        {
          type: 'mc',
          q: 'Wereldtuberculosedag valt op 24 maart. Op die dag in 1882 presenteerde een Duitse arts de tbc-bacterie. Wie?',
          options: ['Paul Ehrlich', 'Rudolf Virchow', 'Robert Koch', 'Emil von Behring'],
          answer: 2,
          info: 'Koch kreeg er in 1905 de Nobelprijs voor. Het Robert Koch-Institut in Berlijn is naar hem vernoemd.'
        },
        {
          type: 'mc',
          q: 'Het Duitse Bayer bracht in 1898 een nieuw middel op de markt als hoestmiddel, ook voor kinderen, onder de merknaam…',
          options: ['Cocaïne', 'Morfine', 'Heroïne', 'Codeïne'],
          answer: 2,
          info: 'Echt waar: Bayer verkocht heroïne als hoeststiller, en dacht dat het minder verslavend was dan morfine. Dezelfde chemicus, Felix Hoffmann, maakte in 1897 ook aspirine. In 1913 stopte Bayer met de productie.'
        }
      ]
    },

    {
      title: 'Bonn, BAS & GIZ', emoji: '🏛️',
      questions: [
        {
          type: 'mc',
          q: 'Het Bundesamt für Soziale Sicherung (BAS), waar we op bezoek gaan, had tot 2020 een andere naam. Welke?',
          options: ['Bundesgesundheitsamt', 'Bundesversicherungsamt', 'Reichsversicherungsamt', 'Bundesamt für Krankenkassen'],
          answer: 1,
          info: 'Opgericht in 1956 als Bundesversicherungsamt, sinds 1 januari 2020 het BAS. Het beheert onder meer het Gesundheitsfonds.'
        },
        {
          type: 'mc',
          q: 'De GIZ heeft twee hoofdzetels. De ene is Bonn. Wat is de andere?',
          options: ['Berlijn', 'Frankfurt am Main', 'Eschborn', 'Keulen'],
          answer: 2,
          info: 'Eschborn ligt vlak naast Frankfurt. De GIZ ontstond op 1 januari 2011 uit een fusie van GTZ, DED en InWEnt.'
        },
        {
          type: 'mc',
          q: 'Op 20 juni 1991 stemde de Bondsdag over de verhuizing van regering en parlement van Bonn naar Berlijn. Met hoeveel stemmen verschil won Berlijn?',
          options: ['2', '18', '74', '176'],
          answer: 1,
          info: '338 tegen 320. Het debat duurde bijna twaalf uur.'
        },
        {
          type: 'mc',
          q: 'Haribo is in 1920 in Bonn opgericht. Waar staat de naam voor?',
          options: ['Hans Riegel Bonn', 'Hartmut Richter Bonn', 'Haus Rheinischer Bonbons', 'Harte Rinder-Bonbons'],
          answer: 0,
          info: 'Hans Riegel begon in een washok in Bonn-Kessenich. In 1922 kwam de “Tanzbär”, de voorloper van de goudbeer.'
        }
      ]
    },

    {
      title: 'Onderweg', emoji: '🚆',
      questions: [
        {
          type: 'mc',
          q: 'Hoeveel procent van de Duitse langeafstandstreinen (ICE/IC) was in oktober 2026 op tijd?',
          options: ['36%', '56%', '76%', '91%'],
          answer: 1,
          info: '56,2%. “Op tijd” betekent bij DB: minder dan 6 minuten te laat. Het doel voor 2026 was 60%.'
        },
        {
          type: 'mc',
          q: 'Het Deutschlandticket (onbeperkt stads- en streekvervoer) kostte bij de start in 2023 € 49 per maand. Wat kost het vanaf 1 januari 2027?',
          options: ['€ 55,00', '€ 63,00', '€ 66,80', '€ 79,00'],
          answer: 2,
          info: 'Nu is het nog € 63. Vanaf 2027 wordt de prijs met een vaste formule berekend in plaats van politiek onderhandeld.'
        }
      ]
    },

    {
      title: 'Kerstmarkten', emoji: '🎄',
      questions: [
        {
          type: 'mc',
          q: 'De Bonner Weihnachtsmarkt opende dit jaar voor het eerst níét op een vrijdag. Wanneer dan wel?',
          options: ['Maandag 16 november', 'Woensdag 18 november', 'Donderdag 19 november', 'Zaterdag 21 november'],
          answer: 1,
          info: 'Hij loopt tot en met 23 december. Van 27 december tot 6 januari volgt de Dreikönigsmarkt op de Remigiusplatz.'
        },
        {
          type: 'mc',
          q: 'De Dresdner Striezelmarkt (sinds 1434) is een van de oudste kerstmarkten van Duitsland. Waar is hij naar vernoemd?',
          options: ['Een lokale heilige', 'De stol (Striezel)', 'Een Saksische koning', 'Gestreepte zuurstokken'],
          answer: 1,
          info: '“Striezel” is een oud woord voor Stollen, het kerstbrood waar Dresden beroemd om is.'
        },
        {
          type: 'mc',
          q: 'Bij een Feuerzangenbowle steek je iets in brand boven een ketel hete rode wijn. Wat?',
          options: ['Een kaneelstok in cognac', 'Een suikerbrood gedrenkt in rum', 'Sinaasappelschillen in jenever', 'Een kruidnagel in kirsch'],
          answer: 1,
          info: 'De brandende suiker druppelt in de punch. Bekend van de Duitse filmklassieker “Die Feuerzangenbowle” (1944).'
        }
      ]
    },

    {
      title: 'Over elkaar', emoji: '🧑‍🤝‍🧑',
      questions: [
        {
          type: 'vote',
          q: 'Wie van ons is het vaakst in Duitsland geweest?',
          time: 25
        },
        {
          type: 'vote',
          q: 'Wie van ons verdwaalt als eerste in Bonn?',
          time: 25
        },
        {
          type: 'vote',
          q: 'Wie van ons spreekt het slechtst Duits?',
          time: 25
        },
        {
          type: 'vote',
          q: 'Wie van ons stelt bij de GIZ de lastigste vraag?',
          time: 25
        },
        {
          type: 'vote',
          q: 'Wie van ons staat als eerste met een Glühwein in de hand?',
          time: 25
        },
        {
          type: 'vote',
          q: 'Wie van ons komt met de meeste kerstmarktinkopen thuis?',
          time: 25
        },
        {
          type: 'vote',
          q: 'Bonn-e-fooi: de lunch rond het hotel is vrij, dus zelf regelen! Wie van ons zit als eerste aan tafel?',
          time: 30
        }
      ]
    },

    {
      title: 'Finale', emoji: '🏆',
      questions: [
        {
          type: 'estimate',
          q: 'Schattingsvraag: hoeveel mensen werkten er eind 2025 bij de GIZ, wereldwijd?',
          unit: 'medewerkers',
          answer: 23787,
          time: 45,
          info: '23.787 mensen in bijna 120 landen. Ongeveer twee derde werkt als lokale medewerker in een partnerland.'
        }
      ]
    }
  ]
};
