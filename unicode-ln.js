'use strict';
/* Letters and numbers (\p{L} and \p{N}, Unicode 17.0), for a Node.js built without the Unicode tables: the one
   inside the Android TV app can't run /[^\p{L}\p{N}]/u. Made by scripts/gen-unicode-ln.js – don't edit by hand.
   Each range is "gap from the end of the one before, length - 1" in base 36. */
const PACKED = '1c,9 8,p 7,p 1c,0 8,1 2,0 4,1 2,2 2,m 2,u 2,cp 5,b f,4 8,0 2,0 3m,4 2,1 3,3 2,0 7,0 2,2 2,0 2,j 2,2a 2,3u 9,4l 2,11 3,0 7,14 20,q 5,3 1a,16 m,9 5,1 2,2q 2,0 g,1 8,e 3,0 h,0 2,t u,2g c,0 f,16 a,1 5,0 6,l 5,0 a,0 4,0 o,o 8,a 6,n 2,6 h,15 1n,1h 4,0 j,0 8,9 5,9 2,f 5,7 3,1 3,l 2,6 2,0 4,3 4,0 h,0 e,1 2,2 5,b 3,5 3,0 9,5 5,1 3,l 2,6 2,1 2,1 2,1 w,3 2,0 8,9 3,2 h,8 2,2 2,l 2,6 2,1 2,4 4,0 j,0 g,1 5,9 a,0 c,7 3,1 3,l 2,6 2,1 2,4 4,0 v,1 2,2 5,9 2,6 c,0 2,5 4,2 2,3 4,1 2,0 2,1 4,1 4,2 4,b n,0 m,c j,7 2,2 2,m 2,f 4,0 r,2 2,1 3,1 5,9 9,6 2,0 5,7 2,2 2,m 2,9 2,4 4,0 v,2 2,1 5,9 2,1 i,8 2,2 2,14 3,0 h,0 6,2 2,9 5,i 2,5 6,h 4,n 2,8 2,0 3,6 w,9 i,1b 2,1 d,6 a,9 14,1 2,0 2,4 2,n 2,0 2,9 2,1 a,0 3,4 2,0 a,9 3,3 x,0 w,j d,7 2,z s,4 38,16 l,a 7,5 5,3 4,0 4,1 8,2 5,c d,0 2,9 7,11 2,0 6,0 3,16 2,98 2,3 3,6 2,0 2,3 3,14 2,3 3,w 2,3 3,6 2,0 2,3 3,e 2,1k 2,3 3,1u f,j 4,f h,2d 3,5 4,h7 3,g 2,p 6,22 4,a 8,h e,i f,h f,c 2,2 g,1f 10,0 5,0 4,9 7,9 n,9 7,2g 8,4 3,x 2,0 6,1x b,u 14,13 3,4 c,17 5,p 7,a 12,m a,1g 18,9 7,9 e,0 2m,1a i,7 4,9 16,t e,1j r,z t,9 4,1c 3,a 6,16 3,2 16,3 2,5 2,1 4,0 6,5b 1t,7p 3,5 3,11 3,5 3,7 2,0 2,0 2,0 2,u 3,1g 2,6 2,0 4,2 2,6 4,3 3,5 5,c 6,2 2,6 38,1 3,5 6,a 7,c 2u,0 5,0 3,9 2,0 4,4 7,0 2,0 2,0 2,3 2,a 3,3 6,4 5,0 2,1l k7,1n 27,l hj,t vh,6c 7,3 4,1 a,0 3,11 2,0 6,0 3,1j 8,0 h,m a,6 2,6 2,6 2,6 2,6 2,6 2,6 2,6 29,0 d2,2 q,8 8,4 3,4 5,2d 7,2 2,2h 2,3 6,16 2,2l 4,3 b,v 1d,f x,9 v,7 2,e x,9 14,e 8x,533 1t,h3g 1w,19 3,7g 4,r l,1a h,u 3,27 14,8 3,2u 3,29 l,g 2,2 2,3 2,m e,5 b,1f f,1d t,9 p,5 4,0 2,1 2,11 b,m q,s 8,1a t,a 7,4 2,o 2,14 o,2 2,7 5,9 7,m 4,0 4,1d 2,0 4,1 3,4 3,0 2,0 p,2 3,a 8,2 d,5 3,5 3,5 a,6 2,6 2,16 2,d 7,36 e,9 7,8mb d,m 5,1c 6it,a5 3,2x 13,6 d,4 6,0 2,9 2,c 2,4 2,0 2,1 2,1 2,2z y,a2 j,1r 3,1h 15,b 39,4 2,3q k,9 8,p 7,p c,2g 4,5 3,5 3,5 3,2 10,b 2,p 2,i 2,1 2,e 3,d z,3e d,18 d,1k i,1 6t,s 4,1c h,q 5,z a,t 6,11 b,t 3,z 5,7 2,4 17,4d 3,9 7,z 5,z 5,13 9,1f d,a 2,e 2,6 2,1 2,a 2,e 2,6 2,1 4,1f d,8m a,l b,7 p,5 2,15 2,8 1y,5 3,0 2,17 2,1 4,0 3,m 3,u 3,11 9,8 1d,i 2,1 6,w 5,p 7,p 13,1j 5,j 3,1a g,3 2,2 2,s b,8 o,u 2,v x,7 2,r 7,4 h,1h b,l 3,q 6,p o,6 29,20 1k,1e e,1e 8,15 d,9 7,11 a,m 63,u 2,15 7,1 h,5 1l,13 9,l c,3 s,h 1b,r l,m d,1g r,t 2,1 3,0 e,18 x,o 8,9 a,z g,9 5,0 3,0 9,y 4,0 d,1b f,3 c,a 2,0 5,j c,h 2,o k,1 1s,6 2,0 2,3 2,e 2,9 8,1a i,9 c,7 3,1 3,l 2,6 2,1 2,4 4,0 j,0 d,4 v,9 2,0 3,0 2,11 2,0 q,0 2,0 19,1g j,3 6,9 6,2 v,1b l,1 2,0 9,9 4n,1a 16,3 11,1b l,0 c,9 13,16 e,0 8,9 7,j t,q m,b 5,6 56,17 39,2a d,7 3,0 3,7 2,1 2,n g,0 2,0 f,9 1z,7 3,12 h,0 2,0 t,0 b,13 8,0 m,0 c,19 k,0 j,20 5k,w g,9 7,8 2,10 i,0 g,s 6,t 35,6 2,1 2,11 m,0 a,9 7,5 2,1 2,v f,0 8,9 7,17 5,9 6v,i g,0 2,c 2,x t,9 2f,0 g,k 18,pl 2v,32 i,5f 219,2o g,tr i,5 q,32y 6,g6 5a2,t j,9 1c7,fs 8,u 2,9 7,26 2,9 7,t j,1b h,3 d,9 2,6 2,k 6,i c1,18 4,9 5j,2e a,o 3,o 19,22 6,0 1v,c 1t,1 2,0 f,4 a,5p1 16,v 2q,36 6pq,3 2,6 2,1 2,82 g,0 u,2 3,0 f,3 9,az 1s5,2y 6,c 4,8 8,9 387,9 153,j d,j 31,o 3s,2c 2,1y 2,1 3,0 3,1 3,3 2,b 2,0 2,6 2,1s 2,3 3,7 2,6 2,r 2,3 2,4 2,0 4,6 2,9f 3,o 2,o 2,u 2,o 2,u 2,o 2,u 2,o 2,u 2,o 2,7 3,1d 1dt,u 7,5 7a,1p 43,18 b,6 3,9 5,0 8y,t j,17 5,9 d3,r 5,9 5z,t 3,a 5i,u 2,2 2,1 2,6 3,4 a,1 69,6 2,3 2,1 2,e 2,5g 3,8 1d,1v 8,0 5,9 m0,1m 2,2 2,3 25,18 2,e 5f,3 2,q 2,1 2,0 3,0 2,9 2,3 2,0 2,0 7,0 5,0 2,0 2,0 2,2 2,1 2,0 3,0 2,0 2,0 2,0 2,0 2,1 2,0 3,3 2,6 2,3 2,3 2,0 2,9 2,g 6,2 2,4 2,g g5,c 25g,9 sn,wyn x,3dp 3,4gd 3,5rk g,h9 1wj,f1 15v,3t6 6,6jt';

const starts = [];
const ends = [];
let at = 0;
for (const r of PACKED.split(' ')) {
  const [gap, len] = r.split(',');
  at += parseInt(gap, 36);
  starts.push(at);
  at += parseInt(len, 36);
  ends.push(at);
}

function isLetterOrNumber(cp) {
  let lo = 0, hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < starts[mid]) hi = mid - 1;
    else if (cp > ends[mid]) lo = mid + 1;
    else return true;
  }
  return false;
}

// The same as String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
function normName(s) {
  let out = '';
  for (const ch of String(s).toLowerCase()) if (isLetterOrNumber(ch.codePointAt(0))) out += ch;
  return out;
}

module.exports = { normName, isLetterOrNumber, unicode: '17.0' };
