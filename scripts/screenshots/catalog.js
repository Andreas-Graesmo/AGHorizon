'use strict';
/* The demo catalogue behind the website screenshots: made-up channels, movies and series, so the pictures show
   nothing that belongs to anyone else. Every title, person and channel name here is fictional. */

// art: scene kind (art.js), palette, seed
const MOVIES = [
  { id: 101, name: 'The Long Horizon', year: 2025, genre: 'Drama', cat: 'Drama', rating: 8.1, mins: 128, art: ['range', 'dusk', 3], tag: 'Some roads only go one way.', plot: 'After her father’s death, a ferry pilot drives the length of the country with his ashes and a stranger she can’t quite get rid of.' },
  { id: 102, name: 'Northern Signal', year: 2025, genre: 'Sci-Fi, Thriller', cat: 'Sci-Fi', rating: 7.8, mins: 116, art: ['aurora', 'night', 7], tag: 'Something is answering.', plot: 'A radio operator at a remote Arctic station picks up a transmission that seems to come from next week.' },
  { id: 103, name: 'Glass Orbit', year: 2024, genre: 'Sci-Fi, Adventure', cat: 'Sci-Fi', rating: 7.4, mins: 134, art: ['orbit', 'violet', 11], tag: 'Home is a long way down.', plot: 'The last crew of a failing space station has ninety minutes to decide who gets the only seat home.' },
  { id: 104, name: 'Salt & Ember', year: 2024, genre: 'Drama, Romance', cat: 'Drama', rating: 7.2, mins: 109, art: ['sea', 'ember', 5], tag: 'One summer. Two kitchens.', plot: 'Two rival cooks on a small island are forced to share one kitchen for the busiest summer of their lives.' },
  { id: 105, name: 'The Quiet Fjord', year: 2023, genre: 'Thriller, Mystery', cat: 'Thriller', rating: 7.6, mins: 112, art: ['fjord', 'steel', 2], tag: 'Everyone here keeps a secret.', plot: 'A detective returns to the village she left at seventeen when a boat drifts ashore with no one aboard.' },
  { id: 106, name: 'Velvet Static', year: 2025, genre: 'Sci-Fi, Crime', cat: 'Sci-Fi', rating: 6.9, mins: 104, art: ['city', 'neon', 13], tag: 'The city never stops broadcasting.', plot: 'A late-night radio host realises the callers to her show are describing crimes before they happen.' },
  { id: 107, name: 'Copper Sky', year: 2022, genre: 'Western, Adventure', cat: 'Adventure', rating: 7.0, mins: 121, art: ['dunes', 'desert', 4], tag: 'The desert keeps what it takes.', plot: 'A surveyor and a runaway cross three hundred miles of desert with a map no one else is supposed to have.' },
  { id: 108, name: 'Hollow Pines', year: 2024, genre: 'Horror, Thriller', cat: 'Thriller', rating: 6.6, mins: 97, art: ['forest', 'moss', 9], tag: 'Don’t follow the lights.', plot: 'A weekend in a cabin turns strange when the forest around it begins to move a little closer every night.' },
  { id: 109, name: 'Midnight Ferry', year: 2023, genre: 'Mystery', cat: 'Thriller', rating: 7.3, mins: 101, art: ['lighthouse', 'night', 21], tag: 'Last crossing. No return.', plot: 'Eleven passengers board the last ferry of the season. Only ten names are on the manifest.' },
  { id: 110, name: 'Second Sun', year: 2025, genre: 'Sci-Fi, Drama', cat: 'Sci-Fi', rating: 8.0, mins: 139, art: ['dunes', 'twin', 17], tag: 'A new dawn. A new world.', plot: 'Generations after landfall, a young engineer finds the colony’s founding story was carefully rewritten.' },
  { id: 111, name: 'The Lighthouse Job', year: 2024, genre: 'Comedy, Crime', cat: 'Comedy', rating: 7.1, mins: 99, art: ['lighthouse', 'dusk', 8], tag: 'The worst heist. The best plan.', plot: 'Four retirees plan to rob the island’s only bank. Their getaway vehicle is a lighthouse tender.' },
  { id: 112, name: 'Paper Lanterns', year: 2022, genre: 'Romance, Drama', cat: 'Drama', rating: 7.5, mins: 114, art: ['lanterns', 'plum', 6], tag: 'Write it down. Let it go.', plot: 'Two strangers keep meeting at the same summer festival, one year at a time.' },
  { id: 113, name: 'Neon Summer', year: 2023, genre: 'Comedy', cat: 'Comedy', rating: 6.8, mins: 95, art: ['city', 'sunset', 12], tag: 'Best. Summer. Ever. Probably.', plot: 'Three friends have one summer left before college and one very bad idea for a road trip.' },
  { id: 114, name: 'The Cartographer', year: 2021, genre: 'Drama, History', cat: 'Drama', rating: 7.7, mins: 131, art: ['range', 'gold', 19], tag: 'Every map is a story.', plot: 'A mapmaker in 1890 is sent to chart a valley that the people who live there would rather keep off the map.' },
  { id: 115, name: 'Foxglove', year: 2025, genre: 'Thriller', cat: 'Thriller', rating: 6.9, mins: 106, art: ['forest', 'crimson', 14], tag: 'Beautiful. Deadly.', plot: 'A botanist inherits her aunt’s garden and the list of names hidden among the seed packets.' },
  { id: 116, name: 'Run, Rabbit', year: 2024, genre: 'Comedy, Family', cat: 'Comedy', rating: 6.7, mins: 92, art: ['hills', 'spring', 10], tag: 'Ready. Steady. Hop.', plot: 'A clumsy town mascot accidentally enters the country’s biggest cross-country race.' },
  { id: 117, name: 'Atlas of Small Things', year: 2024, genre: 'Documentary', cat: 'Documentary', rating: 8.3, mins: 88, art: ['macro', 'spring', 15], tag: 'The world, up close.', plot: 'A year in one meadow, filmed at the scale of the creatures that live in it.' },
  { id: 118, name: 'Beneath the Ice', year: 2023, genre: 'Documentary', cat: 'Documentary', rating: 8.0, mins: 94, art: ['ice', 'arctic', 22], tag: 'Life where the light ends.', plot: 'Divers and scientists spend a polar winter documenting life under a frozen sea.' },
  { id: 119, name: 'Low Tide', year: 2022, genre: 'Drama', cat: 'Drama', rating: 7.0, mins: 103, art: ['sea', 'pearl', 18], tag: 'What the water leaves behind.', plot: 'A father and his estranged son spend one week repairing the family boat, and very little else.' },
  { id: 120, name: 'Wild Coast', year: 2025, genre: 'Documentary', cat: 'Documentary', rating: 8.2, mins: 90, art: ['fjord', 'teal', 23], tag: 'Where the land meets the sea.', plot: 'Orcas, eagles and one very patient film crew along a thousand kilometres of northern coastline.' },
  { id: 121, name: 'Orbiter', year: 2021, genre: 'Sci-Fi', cat: 'Sci-Fi', rating: 7.1, mins: 118, art: ['orbit', 'ember', 25], tag: 'Alone. Not lonely.', plot: 'A solo pilot on a ten-year mission begins to suspect she isn’t the only one aboard.' },
  { id: 122, name: 'The Last Lift', year: 2023, genre: 'Comedy, Romance', cat: 'Comedy', rating: 6.9, mins: 98, art: ['range', 'snow', 26], tag: 'Stuck. Together.', plot: 'Two ski instructors who can’t stand each other get stuck on the season’s final chairlift ride.' },
];

const SERIES = [
  { id: 201, name: 'Driftwood', year: 2024, genre: 'Drama', cat: 'Drama', rating: 8.4, epMins: 52, art: ['sea', 'teal', 31], seasons: 3, eps: 8, plot: 'Three generations of a fishing family hold on to their harbour town as the industry around them changes.' },
  { id: 202, name: 'The Archive', year: 2025, genre: 'Sci-Fi, Mystery', cat: 'Sci-Fi', rating: 8.6, epMins: 47, art: ['orbit', 'night', 32], seasons: 2, eps: 8, plot: 'A librarian finds a room in the national archive full of records of events that never happened. Yet.' },
  { id: 203, name: 'Harbour Lights', year: 2023, genre: 'Crime, Drama', cat: 'Crime', rating: 8.1, epMins: 58, art: ['lighthouse', 'steel', 33], seasons: 3, eps: 6, plot: 'A port-town police unit untangles one case per season, and the town’s past every episode.' },
  { id: 204, name: 'Orbit Kitchen', year: 2025, genre: 'Comedy', cat: 'Comedy', rating: 7.7, epMins: 24, art: ['orbit', 'sunset', 34], seasons: 2, eps: 10, plot: 'The chef of the first restaurant in low orbit has a tiny kitchen, picky astronauts and no gravity.' },
  { id: 205, name: 'Northbound', year: 2024, genre: 'Documentary, Travel', cat: 'Documentary', rating: 8.3, epMins: 44, art: ['aurora', 'teal', 35], seasons: 2, eps: 6, plot: 'A slow journey from the southern tip of the continent to the Arctic Ocean, by train, boat and bicycle.' },
  { id: 206, name: 'Signal Lost', year: 2023, genre: 'Sci-Fi, Thriller', cat: 'Sci-Fi', rating: 7.9, epMins: 49, art: ['city', 'neon', 36], seasons: 1, eps: 8, plot: 'The day every phone in the city goes quiet, a courier becomes the only way to get a message across town.' },
  { id: 207, name: 'Fieldnotes', year: 2022, genre: 'Documentary', cat: 'Documentary', rating: 8.5, epMins: 50, art: ['macro', 'gold', 37], seasons: 2, eps: 6, plot: 'One naturalist, one notebook and the wildlife of six very different landscapes.' },
  { id: 208, name: 'The Night Desk', year: 2024, genre: 'Drama', cat: 'Drama', rating: 8.0, epMins: 55, art: ['city', 'night', 38], seasons: 2, eps: 8, plot: 'Inside the overnight newsroom of a city paper, where the stories break after everyone else has gone home.' },
  { id: 209, name: 'High Country', year: 2021, genre: 'Western, Drama', cat: 'Drama', rating: 7.8, epMins: 51, art: ['range', 'ember', 39], seasons: 3, eps: 8, plot: 'A ranching family fights for its land, and against itself, in a valley that is running out of water.' },
  { id: 210, name: 'Little Lanterns', year: 2025, genre: 'Animation, Kids', cat: 'Kids', rating: 7.9, epMins: 22, art: ['lanterns', 'spring', 40], seasons: 2, eps: 10, plot: 'Every night, a family of lantern spirits lights the way for whoever is lost in the old town.' },
];

const EP_TITLES = ['Pilot', 'The Long Way Round', 'High Water', 'What We Keep', 'Crosscurrent', 'Static', 'Old Friends', 'The Ledger',
  'Northern Lights', 'Undertow', 'Second Chances', 'The Visitor', 'Fault Lines', 'Homecoming', 'Slack Tide', 'Nightfall', 'Paper Trail',
  'The Storm', 'Open Water', 'Last Light', 'A Small Favour', 'Breakwater', 'Ghost Signal', 'Firstlight'];
const EP_PLOTS = ['An unexpected arrival changes everyone’s plans.', 'An old promise comes back to collect.', 'A storm keeps everyone in the same room for one long night.',
  'A decision made years ago finally has consequences.', 'Two old rivals discover they need each other.', 'A small lie grows out of control.',
  'Someone is not who they said they were.', 'The truth comes out at the worst possible moment.'];

// Live channels: name, group, logo [label, shape, color, ink]
const CHANNELS = [
  ['Horizon One', 'Entertainment', ['H1', 'round', '#ff7a59', '#fff']],
  ['Horizon Two', 'Entertainment', ['H2', 'round', '#6ea1ff', '#fff']],
  ['Northwind News', 'News', ['NW', 'square', '#d6303a', '#fff']],
  ['Meridian 24', 'News', ['24', 'circle', '#1f6feb', '#fff']],
  ['Market Watch', 'News', ['MW', 'slant', '#0e9f6e', '#fff']],
  ['Weather Now', 'News', ['☀', 'circle', '#f5b100', '#1a1a1a']],
  ['Pulse Sports', 'Sports', ['P', 'hex', '#ff3d5a', '#fff']],
  ['Arena Sports 1', 'Sports', ['A1', 'slant', '#1d4ed8', '#fff']],
  ['Arena Sports 2', 'Sports', ['A2', 'slant', '#7c3aed', '#fff']],
  ['Goal TV', 'Sports', ['GOAL', 'pill', '#16a34a', '#fff']],
  ['Velo Live', 'Sports', ['VL', 'diamond', '#f97316', '#fff']],
  ['Atlas Docs', 'Documentary', ['ATLAS', 'pill', '#0f766e', '#fff']],
  ['Wildlife HD', 'Documentary', ['W', 'circle', '#65a30d', '#fff']],
  ['Science Now', 'Documentary', ['SN', 'hex', '#0891b2', '#fff']],
  ['History Lane', 'Documentary', ['HL', 'square', '#a16207', '#fff']],
  ['Cinema Classic', 'Movies', ['CC', 'circle', '#b91c1c', '#ffe9a8']],
  ['Neon Movies', 'Movies', ['N', 'square', '#db2777', '#fff']],
  ['Drama Plus', 'Movies', ['D+', 'round', '#4f46e5', '#fff']],
  ['Laugh Track', 'Entertainment', ['LOL', 'pill', '#facc15', '#1a1a1a']],
  ['Cook & Co', 'Lifestyle', ['C&C', 'round', '#ea580c', '#fff']],
  ['Travel Bound', 'Lifestyle', ['TB', 'circle', '#0284c7', '#fff']],
  ['Home & Garden', 'Lifestyle', ['HG', 'square', '#15803d', '#fff']],
  ['Kids Planet', 'Kids', ['KP', 'circle', '#8b5cf6', '#fff']],
  ['Tiny Tales', 'Kids', ['TT', 'round', '#f472b6', '#fff']],
  ['Beat TV', 'Music', ['BEAT', 'pill', '#111827', '#22d3ee']],
  ['Jazz Lounge', 'Music', ['JL', 'circle', '#78350f', '#fde68a']],
  ['Retro Hits', 'Music', ['80s', 'slant', '#c026d3', '#fff']],
  ['Coastline TV', 'Regional', ['CTV', 'round', '#0e7490', '#fff']],
  ['Fjord 1', 'Regional', ['F1', 'hex', '#2563eb', '#fff']],
  ['City Pulse', 'Regional', ['CP', 'diamond', '#e11d48', '#fff']],
];

const SHOWS = {
  News: ['Morning Report', 'News at Noon', 'World Today', 'Business Briefing', 'The Evening News', 'Late Edition', 'Weather Watch', 'Newsroom Live', 'Global Desk', 'The Week Ahead'],
  Sports: ['Matchday Live', 'Football Tonight', 'Highlights', 'Tour Stage 14', 'Racing Weekend', 'The Locker Room', 'Ski Jumping World Cup', 'Handball: Semi-final', 'Sports Desk', 'Classic Matches'],
  Documentary: ['Planet Deep', 'Wild Coast', 'Ancient Engineers', 'The Big Migration', 'Inside the Cell', 'Lost Cities', 'Night Skies', 'Rivers of Ice', 'Built to Last', 'Hidden Kingdoms'],
  Movies: ['The Long Horizon', 'Copper Sky', 'Midnight Ferry', 'Paper Lanterns', 'The Cartographer', 'Low Tide', 'Salt & Ember', 'The Quiet Fjord', 'Neon Summer', 'Orbiter'],
  Entertainment: ['Saturday Night Quiz', 'The Big Bake', 'Talk at Ten', 'Comedy Hour', 'Island Life', 'Driftwood', 'Harbour Lights', 'Game On', 'Late Night Live', 'The Showcase'],
  Lifestyle: ['Weeknight Dinners', 'Grand Designs Abroad', 'Garden Rescue', 'Taste of the Coast', 'Northbound', 'Small Spaces', 'Market Kitchen', 'Weekend Escapes', 'Fixer Upper North', 'Street Food Stories'],
  Kids: ['Little Lanterns', 'Robo Pals', 'Story Time', 'Paws Patrol Club', 'Science Squad', 'The Cloud Kids', 'Draw With Me', 'Ocean Friends', 'Tiny Builders', 'Moonbeam Tales'],
  Music: ['Top 40 Countdown', 'Live Sessions', 'Unplugged', 'Retro Hour', 'Night Grooves', 'Festival Highlights', 'Jazz at Midnight', 'Morning Mix', 'Classic Vinyl', 'Request Hour'],
  Regional: ['Coast Tonight', 'Local News', 'Harbour Report', 'Fjord Weather', 'City Council Live', 'Regional Sports', 'Our Town', 'The Valley', 'Road Trip North', 'Island Hopping'],
};
const SHOW_DESC = ['Live coverage, analysis and interviews.', 'A fresh episode of the popular series.', 'Highlights and the best moments from this week.',
  'The latest updates from home and abroad.', 'An hour of the best the season has to offer.', 'Join the team for a look behind the scenes.'];

const FIRST = ['Ingrid', 'Mateo', 'Aiko', 'Jonas', 'Leila', 'Tomas', 'Freya', 'Nikolai', 'Ama', 'Elias', 'Sofia', 'Ravi', 'Maren', 'Oskar', 'Noor', 'Lucas', 'Hana', 'Felix', 'Iris', 'Viktor', 'Selma', 'Arjun', 'Clara', 'Emil'];
const LAST = ['Halvorsen', 'Okafor', 'Lindqvist', 'Moreau', 'Tanaka', 'Brennan', 'Alvarez', 'Kowalski', 'Nakamura', 'Strand', 'Delacroix', 'Mensah', 'Vik', 'Hartmann', 'Rossi', 'Haugen', 'Oyelaran', 'Castell', 'Novak', 'Aaland'];

function people(seed, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`${FIRST[(seed * 7 + i * 5) % FIRST.length]} ${LAST[(seed * 3 + i * 7) % LAST.length]}`);
  return out;
}

// What each live channel shows: a scene (art.js) or a movie's backdrop, and what's laid over it.
const LIVE = {
  'Horizon One': ['range', 'dusk', 51], 'Horizon Two': ['lanterns', 'plum', 52],
  'Northwind News': ['studio', 'steel', 53, { news: 'Coastal storm: evening ferries cancelled', label: 'NORTHWIND NEWS', ticker: 'Rail services back to normal after signal fault  ·  New bridge opens to traffic on Monday  ·  Sunny spells forecast for the weekend' }],
  'Meridian 24': ['studio', 'steel', 54, { news: 'Election night: first results expected at 22:00', label: 'MERIDIAN 24', ticker: 'Turnout higher than four years ago  ·  Polls close in the north at 21:00' }],
  'Market Watch': ['studio', 'steel', 55, { news: 'Markets close higher on energy shares', label: 'MARKETS', ticker: 'Index +1.2%  ·  Oil steady  ·  Krone firms against the euro' }],
  'Weather Now': ['range', 'snow', 56, { news: 'Snow on the mountain passes after midnight', label: 'WEATHER', ticker: 'Gale warning for the coast  ·  Mild and dry in the east tomorrow' }],
  'Pulse Sports': ['pitch', 'steel', 57, { score: ['BRA', '1 – 3', 'VIK', '88:31'] }],
  'Arena Sports 1': ['pitch', 'steel', 58, { score: ['HAV', '2 – 1', 'FJO', '67:12'] }],
  'Arena Sports 2': ['pitch', 'steel', 59, { score: ['NOR', '0 – 0', 'SKO', '12:40'] }],
  'Goal TV': ['pitch', 'steel', 60, { score: ['LYN', '1 – 1', 'ODD', '45:00'] }],
  'Velo Live': ['road', 'spring', 61, { race: ['STAGE 14 · 23 KM TO GO', 'Breakaway of five · 1:42 ahead of the bunch'] }],
  'Atlas Docs': ['ice', 'arctic', 62], 'Wildlife HD': ['fjord', 'teal', 63], 'Science Now': ['orbit', 'night', 64], 'History Lane': ['range', 'gold', 65],
  'Cinema Classic': [114], 'Neon Movies': [106], 'Drama Plus': [104],
  'Laugh Track': ['hills', 'spring', 66], 'Cook & Co': ['sea', 'ember', 67], 'Travel Bound': ['dunes', 'desert', 68], 'Home & Garden': ['macro', 'spring', 69],
  'Kids Planet': ['orbit', 'sunset', 70], 'Tiny Tales': ['lanterns', 'spring', 71],
  'Beat TV': ['city', 'neon', 72, { song: 'Halvorsen & the Tides — Northern Lights' }], 'Jazz Lounge': ['city', 'night', 73, { song: 'The Okafor Trio — Blue Harbour' }], 'Retro Hits': ['city', 'sunset', 74, { song: 'Neon Avenue — Summer of Static' }],
  'Coastline TV': ['lighthouse', 'steel', 75], 'Fjord 1': ['fjord', 'steel', 76], 'City Pulse': ['city', 'dusk', 77],
};

module.exports = { LIVE, MOVIES, SERIES, EP_TITLES, EP_PLOTS, CHANNELS, SHOWS, SHOW_DESC, people };
