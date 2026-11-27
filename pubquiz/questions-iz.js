/* Tweede quiz: Internationale Zaken (geografie, organisaties, partnerlanden, diplomatie).
   Zelfde opbouw als questions.js; geladen door host-iz.html. Eigen spelcode: IZ26. */

window.QUIZ = {
  title: 'Pubquiz Internationale Zaken',
  subtitle: 'VWS IZ · terugreis Bonn → Utrecht, 27 november 2026',
  code: 'IZ26',
  defaultTime: 30,
  // stemvragen met punten: wie met de meerderheid meestemt krijgt dit aantal punten
  votePoints: 10,

  rounds: [
    {
      title: "Geografie", emoji: '🗺️',
      questions: [
        {
          "type": "mc",
          "q": "We komen net uit Duitsland. Hoeveel buurlanden heeft Duitsland?",
          "options": [
            "7",
            "8",
            "9",
            "10"
          ],
          "answer": 2,
          "info": "Negen: Nederland, België, Luxemburg, Frankrijk, Zwitserland, Oostenrijk, Tsjechië, Polen en Denemarken. Meer dan elk ander land in de EU."
        },
        {
          "type": "mc",
          "q": "Welk van deze landen grenst aan de meeste andere landen?",
          "options": ["Brazilië", "DR Congo", "China", "Duitsland"],
          "answer": 2,
          "info": "China: 14 buurlanden, van Noord-Korea tot Afghanistan. Alleen Rusland heeft er ook 14. Brazilië heeft er 10 (alle Zuid-Amerikaanse landen behalve Chili en Ecuador), Duitsland en DR Congo elk 9."
        },
        {
          "type": "mc",
          "q": "Indonesië bouwt een nieuwe hoofdstad op Borneo. Hoe heet die?",
          "options": [
            "Nusantara",
            "Surabaya",
            "Bandung",
            "Medan"
          ],
          "answer": 0,
          "info": "Nusantara ligt in Oost-Kalimantan, het Indonesische deel van Borneo. Jakarta zakt op sommige plekken meerdere centimeters per jaar weg."
        },
        {
          "type": "mc",
          "q": "Zuid-Afrika heeft drie hoofdsteden. Welke stad hoort daar NIET bij?",
          "options": [
            "Pretoria",
            "Johannesburg",
            "Kaapstad",
            "Bloemfontein"
          ],
          "answer": 1,
          "info": "Pretoria (regering), Kaapstad (parlement) en Bloemfontein (hoogste rechter). Johannesburg is wel de grootste stad, en daar zit het NICD."
        }
      ]
    },
    {
      title: "De wereld & haar organisaties", emoji: '🌍',
      questions: [
        {
          "type": "mc",
          "q": "Welke organisatie zit NIET in Den Haag?",
          "options": [
            "Internationaal Gerechtshof",
            "Internationaal Strafhof",
            "OPCW (chemische wapens)",
            "Wereldhandelsorganisatie (WTO)"
          ],
          "answer": 3,
          "info": "De WTO zit in Genève, net als de WHO. Den Haag noemt zich de internationale stad van vrede en recht."
        },
        {
          "type": "mc",
          "q": "Welk land is wel lid van de NAVO, maar niet van de EU?",
          "options": [
            "Oostenrijk",
            "Ierland",
            "Noorwegen",
            "Malta"
          ],
          "answer": 2,
          "info": "Noorwegen stemde twee keer tegen de EU (1972 en 1994). Oostenrijk, Ierland en Malta zijn juist EU-lid maar niet in de NAVO."
        },
        {
          "type": "mc",
          "q": "In welke hoofdstad lopen leeuwen, neushoorns en giraffen in een nationaal park binnen de stadsgrenzen?",
          "options": [
            "Kampala",
            "Nairobi",
            "Addis Abeba",
            "Dar es Salaam"
          ],
          "answer": 1,
          "info": "Nairobi National Park ligt op een paar kilometer van het centrum, met de skyline op de achtergrond van de safarifoto."
        },
        {
          "type": "mc",
          "q": "China is ongeveer zo breed als vijf tijdzones. Hoeveel tijdzones gebruikt het officieel?",
          "options": [
            "1",
            "3",
            "5",
            "7"
          ],
          "answer": 0,
          "info": "Eén: overal geldt Beijing-tijd. In het westen, in Xinjiang, gaat de zon daardoor soms pas rond 10 uur op."
        }
      ]
    },
    {
      title: "Diplomatie & weetjes", emoji: '🎩',
      questions: [
        {
          "type": "mc",
          "q": "Welk land heeft als enige een nationale vlag die niet rechthoekig is?",
          "options": [
            "Zwitserland",
            "Nepal",
            "Vaticaanstad",
            "Bhutan"
          ],
          "answer": 1,
          "info": "Nepal: twee gestapelde driehoekjes. Zwitserland en Vaticaanstad hebben een vierkante vlag, en een vierkant is óók een rechthoek."
        },
        {
          "type": "mc",
          "q": "In 1648 erkende Spanje de onafhankelijkheid van de Republiek, met een verdrag in een Duitse stad. Welke?",
          "options": [
            "Keulen",
            "Aken",
            "Münster",
            "Bonn"
          ],
          "answer": 2,
          "info": "De Vrede van Münster beëindigde de Tachtigjarige Oorlog en was onderdeel van de Vrede van Westfalen, het begin van het moderne statenstelsel."
        },
        {
          "type": "mc",
          "q": "De kortste oorlog uit de geschiedenis, Groot-Brittannië tegen Zanzibar in 1896, duurde ongeveer…",
          "options": [
            "40 minuten",
            "4 uur",
            "4 dagen",
            "4 weken"
          ],
          "answer": 0,
          "info": "Tussen 38 en 45 minuten, afhankelijk van de bron. Daarna was de opvolging van de sultan beslist."
        }
      ]
    },
    {
      title: "Over elkaar", emoji: '🙋',
      questions: [
        {
          "type": "vote",
          "q": "Wie van ons zou de beste minister-president zijn?",
          "time": 25
        },
        {
          "type": "vote",
          "q": "Wie van ons zou de beste ambassadeur zijn?",
          "time": 25
        },
        {
          "type": "vote",
          "q": "Wie van ons valt als eerste in slaap in de trein terug?",
          "time": 25
        }
      ]
    },
    {
      title: "Finale", emoji: '🏁',
      questions: [
        {
          "type": "estimate",
          "q": "Schattingsvraag: hoe hoog is de Kilimanjaro, de hoogste berg van Afrika, in meters?",
          "unit": "meter",
          "answer": 5895,
          "info": "5.895 meter. Hij ligt in Tanzania, vlak bij de grens met Kenia; vanuit Kenia heb je het mooiste uitzicht."
        }
      ]
    }
  ]
};
