'use strict';
/* Where "AG Horizon cloud" sync keeps its encrypted data: a Supabase project set up with supabase/sync.sql.
   Both values are meant to be public: the key only lets the app call the three sync functions, and everything it
   stores is encrypted with a code only the person's computers have. Leave them empty and the app offers only
   syncing through a folder. */
const SYNC_CLOUD = {
  url: 'https://trdvddncpfgyghekygoe.supabase.co',   // https://<project>.supabase.co
  key: 'sb_publishable_cGCfXQJ0zH2DqlzXCdXDNQ_GUxNfw2Q',   // the project's publishable (anon) key
};
