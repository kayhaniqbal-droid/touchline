/**
 * Touchline tactics engine.
 *
 * A formation slot is described by a channel (which strip of the pitch —
 * 0 is the team's right, 4 their left) and a line (0 keeper, 4 attack).
 * That is the same idea as the row/column grid football data providers
 * publish, which is why a provider lineup drops straight into the board.
 *
 * This module is imported by index.html in the browser and by the ingest
 * scripts in Node, so both reason about shape identically.
 */

/* ============================================================
   Formations. Coordinates are in "team space": x runs 0 (own
   goal) to 100 (opponent goal); y is 0..100 with larger y on the
   team's RIGHT when they attack to the right of the screen.
   Slots are listed in team-sheet order: GK, back line right to
   left, then forward.
   ============================================================ */
const FORMATIONS = {
  "4-4-2":   [["GK","GK",4,50],["RB","DEF",18,85],["RCB","DEF",13,63],["LCB","DEF",13,37],["LB","DEF",18,15],["RM","MID",32,86],["RCM","MID",28,60],["LCM","MID",28,40],["LM","MID",32,14],["RS","FWD",43,60],["LS","FWD",43,40]],
  "4-2-3-1": [["GK","GK",4,50],["RB","DEF",18,85],["RCB","DEF",13,63],["LCB","DEF",13,37],["LB","DEF",18,15],["RDM","MID",25,62],["LDM","MID",25,38],["RW","MID",35,84],["AM","MID",34,50],["LW","MID",35,16],["ST","FWD",45,50]],
  "4-3-3":   [["GK","GK",4,50],["RB","DEF",18,85],["RCB","DEF",13,63],["LCB","DEF",13,37],["LB","DEF",18,15],["DM","MID",25,50],["RCM","MID",32,68],["LCM","MID",32,32],["RW","FWD",43,84],["ST","FWD",46,50],["LW","FWD",43,16]],
  "4-3-2-1": [["GK","GK",4,50],["RB","DEF",18,85],["RCB","DEF",13,63],["LCB","DEF",13,37],["LB","DEF",18,15],["DM","MID",24,50],["RCM","MID",31,70],["LCM","MID",31,30],["RAM","FWD",39,62],["LAM","FWD",39,38],["ST","FWD",46,50]],
  "4-1-4-1": [["GK","GK",4,50],["RB","DEF",18,85],["RCB","DEF",13,63],["LCB","DEF",13,37],["LB","DEF",18,15],["DM","MID",23,50],["RM","MID",33,86],["RCM","MID",31,62],["LCM","MID",31,38],["LM","MID",33,14],["ST","FWD",43,50]],
  "4-2-2-2": [["GK","GK",4,50],["RB","DEF",18,85],["RCB","DEF",13,63],["LCB","DEF",13,37],["LB","DEF",18,15],["RDM","MID",25,62],["LDM","MID",25,38],["RAM","MID",35,76],["LAM","MID",35,24],["RS","FWD",44,60],["LS","FWD",44,40]],
  "4-4-1-1": [["GK","GK",4,50],["RB","DEF",18,85],["RCB","DEF",13,63],["LCB","DEF",13,37],["LB","DEF",18,15],["RM","MID",31,86],["RCM","MID",27,60],["LCM","MID",27,40],["LM","MID",31,14],["CF","FWD",38,50],["ST","FWD",45,50]],
  "4-2-4":   [["GK","GK",4,50],["RB","DEF",18,85],["RCB","DEF",13,63],["LCB","DEF",13,37],["LB","DEF",18,15],["RCM","MID",27,62],["LCM","MID",27,38],["RW","FWD",42,88],["RS","FWD",45,62],["LS","FWD",45,38],["LW","FWD",42,12]],
  "3-4-3":   [["GK","GK",4,50],["RCB","DEF",14,72],["CB","DEF",12,50],["LCB","DEF",14,28],["RWB","MID",27,90],["RCM","MID",25,60],["LCM","MID",25,40],["LWB","MID",27,10],["RW","FWD",41,84],["ST","FWD",45,50],["LW","FWD",41,16]],
  "3-4-2-1": [["GK","GK",4,50],["RCB","DEF",14,72],["CB","DEF",12,50],["LCB","DEF",14,28],["RWB","MID",28,90],["RCM","MID",25,60],["LCM","MID",25,40],["LWB","MID",28,10],["RAM","FWD",38,66],["LAM","FWD",38,34],["ST","FWD",45,50]],
  "3-5-2":   [["GK","GK",4,50],["RCB","DEF",14,72],["CB","DEF",12,50],["LCB","DEF",14,28],["RWB","MID",29,90],["RCM","MID",27,66],["DM","MID",23,50],["LCM","MID",27,34],["LWB","MID",29,10],["RS","FWD",43,60],["LS","FWD",43,40]],
  "3-2-4-1": [["GK","GK",5,50],["RCB","DEF",15,74],["CB","DEF",13,50],["LCB","DEF",15,26],["RDM","MID",26,62],["LDM","MID",26,38],["RW","MID",40,92],["RAM","MID",36,64],["LAM","MID",36,36],["LW","MID",40,8],["ST","FWD",45,50]],
  "5-3-2":   [["GK","GK",4,50],["RWB","DEF",22,88],["RCB","DEF",16,70],["CB","DEF",14,50],["LCB","DEF",16,30],["LWB","DEF",22,12],["RCM","MID",30,68],["CM","MID",28,50],["LCM","MID",30,32],["RS","FWD",42,60],["LS","FWD",42,40]],
  "5-4-1":   [["GK","GK",4,50],["RWB","DEF",21,88],["RCB","DEF",15,70],["CB","DEF",13,50],["LCB","DEF",15,30],["LWB","DEF",21,12],["RM","MID",29,86],["RCM","MID",27,60],["LCM","MID",27,40],["LM","MID",29,14],["ST","FWD",41,50]],
  "2-3-5":   [["GK","GK",4,50],["RB","DEF",14,64],["LB","DEF",14,36],["RH","MID",26,78],["CH","MID",24,50],["LH","MID",26,22],["OR","FWD",42,90],["IR","FWD",40,70],["CF","FWD",46,50],["IL","FWD",40,30],["OL","FWD",42,10]]
};
const FORMATION_KEYS = Object.keys(FORMATIONS);

/* Club kit colours: token fill, the number on it, and the ring that
   keeps a white or black shirt legible on grass. */
const CLUBS = {
  ARS:["#EF0107","#FFFFFF","#FFD9DA"], COV:["#7CD1F2","#0B2237","#0B2237"],
  BRE:["#D6001C","#FFFFFF","#FFD9DE"], TOT:["#F4F6FA","#0E1740","#0E1740"],
  EVE:["#0B47B5","#FFFFFF","#A8C6FF"], CRY:["#C4122E","#FFFFFF","#FFC9D1"],
  HUL:["#FBB040","#141210","#141210"], MUN:["#DA291C","#FFFFFF","#FFD2CE"],
  IPS:["#2E5FB0","#FFFFFF","#B9CEF3"], SUN:["#E8112D","#FFFFFF","#FFCBD2"],
  NFO:["#DD0000","#FFFFFF","#FFCFCF"], LEE:["#F5F7FA","#12336B","#12336B"],
  BHA:["#0057B8","#FFFFFF","#A9CBF5"], AVL:["#670E36","#95BFE5","#95BFE5"],
  MCI:["#7EBBE4","#0A2440","#0A2440"], BOU:["#D0021B","#FFFFFF","#FFCBD1"],
  NEW:["#1B1A1C","#FFFFFF","#E8E8EA"], LIV:["#C8102E","#FFFFFF","#FFCBD3"],
  FUL:["#F5F7FA","#12161C","#12161C"], CHE:["#0B4FA8","#FFFFFF","#9CC8FF"]
};
function kit(short){ return CLUBS[short] || ["#8A93A5","#0B0F12","#DDE3EC"]; }

/* Phase seeds: a base formation per team, pushed up or dropped
   back and squeezed narrow, plus drawings in pitch coordinates.
   These five are written for Fulham v Chelsea specifically. */
const SCRIPTED_PHASES = [
  { name:"Kick-off shape",
    note:"How both teams lined up at Craven Cottage. Fulham attack right, Chelsea attack left. Drag anyone to start reshaping.",
    home:{f:"4-2-3-1"}, away:{f:"3-4-2-1"}, arrows:[], zones:[] },

  { name:"Chelsea build 3-2-5",
    note:"The back three splits, Gusto and Hato climb the touchlines and Palmer and Rogers sit in the half-spaces. Fulham drop into a compact 4-4-2 and wait.",
    home:{f:"4-4-2", push:-1, squeeze:0.8}, away:{f:"3-2-4-1", push:25},
    arrows:[[88,50,74,24,"pass"],[74,24,52,12,"pass"],[52,12,34,11,"run"]],
    zones:[] },

  { name:"Fulham high press",
    note:"García curves onto Lacroix, King jumps to Lavia and the wide players pin the wing-backs. Fulham press in a 4-2-4 and dare Chelsea to go long.",
    home:{f:"4-2-4", push:26, squeeze:0.88}, away:{f:"3-2-4-1", push:8},
    arrows:[[66,50,78,48,"press"],[60,68,74,62,"press"],[60,32,74,36,"press"]],
    zones:[[62,6,34,88]] },

  { name:"Fulham counter",
    note:"Ball won in midfield. García attacks the channel outside Colwill, Bobb sprints the far post, and Chelsea are caught with three at the back and everyone else upfield.",
    home:{f:"4-2-3-1", push:23, squeeze:1.05},
    away:{f:"3-4-2-1", push:6, pushByRole:{MID:16, FWD:30}},
    arrows:[[46,58,64,51,"pass"],[67,52,88,66,"run"],[59,84,86,40,"run"]],
    zones:[] },

  { name:"Chelsea low block",
    note:"Wing-backs fold into a back five, Palmer and Rogers tuck into the midfield line and Chelsea defend the width of the box. Fulham camp in, Castagne pushes on to make a front five, and the cross comes from the far side.",
    home:{f:"3-2-4-1", push:24}, away:{f:"5-4-1", push:-2, squeeze:0.82},
    arrows:[[56,88,74,22,"pass"],[62,60,80,44,"run"]],
    zones:[[68,16,30,68]] }
];

/* The same five moments, derived for any pair of formations. A back
   three builds in a 3-2-4-1 and defends in a 5-4-1; a back four
   presses in a 4-2-4 and blocks in a 4-4-2. */
function backThree(f){ return f.charAt(0)==="3" || f.charAt(0)==="5"; }
function buildShape(f){ return backThree(f) ? "3-2-4-1" : "4-2-3-1"; }
function pressShape(f){ return backThree(f) ? "3-4-3" : "4-2-4"; }
function blockShape(f){ return backThree(f) ? "5-4-1" : "4-4-2"; }

function genericPhases(fx){
  const H=fx.home.nick||fx.home.team, A=fx.away.nick||fx.away.team;
  const hf=fx.home.formation, af=fx.away.formation;
  return [
    { name:"Kick-off shape",
      note:H+" attack right, "+A+" attack left. These are the elevens as they lined up at "+fx.venue+". Drag anyone to start reshaping.",
      home:{f:hf}, away:{f:af}, arrows:[], zones:[] },
    { name:A+" in possession",
      note:A+" push into a "+buildShape(af)+", stretching the pitch with the wide players and stepping the back line over halfway. "+H+" drop into a compact "+blockShape(hf)+" and wait.",
      home:{f:blockShape(hf), push:-1, squeeze:0.82}, away:{f:buildShape(af), push:24},
      arrows:[[88,50,74,24,"pass"],[74,24,52,12,"pass"]], zones:[] },
    { name:H+" high press",
      note:H+" jump into a "+pressShape(hf)+", match up across the back line and force the ball long. The high line is the risk.",
      home:{f:pressShape(hf), push:25, squeeze:0.88}, away:{f:buildShape(af), push:8},
      arrows:[[66,50,78,48,"press"],[60,68,74,62,"press"],[60,32,74,36,"press"]],
      zones:[[62,6,34,88]] },
    { name:H+" counter",
      note:"Ball won in midfield. "+H+" break at speed while "+A+" are caught with their front players upfield and only the back line home.",
      home:{f:hf, push:23, squeeze:1.05},
      away:{f:af, push:6, pushByRole:{MID:16, FWD:30}},
      arrows:[[46,58,64,51,"pass"],[67,52,88,66,"run"],[59,84,86,40,"run"]], zones:[] },
    { name:A+" low block",
      note:A+" fold into a "+blockShape(af)+" and defend the width of the box. "+H+" camp in, push a full-back on to make a front five, and cross from the far side.",
      home:{f:buildShape(hf), push:24}, away:{f:blockShape(af), push:-2, squeeze:0.82},
      arrows:[[56,88,74,22,"pass"],[62,60,80,44,"run"]],
      zones:[[68,16,30,68]] }
  ];
}

/* Every position label placed on a grid: which channel of the pitch
   it occupies (0 = the team's right touchline, 4 = their left) and
   how far up the team it sits (0 = keeper, 4 = centre forward).
   Reshaping a team is then a matter of keeping people in their
   channel and moving them a line at a time. */
const POS_META = {
  GK:[2,0],
  RB:[0,1], RWB:[0,1], RCB:[1,1], CB:[2,1], LCB:[3,1], LB:[4,1], LWB:[4,1],
  RM:[0,2], RDM:[1,2], RCM:[1,2], RH:[1,2], DM:[2,2], CM:[2,2], CH:[2,2],
  LDM:[3,2], LCM:[3,2], LH:[3,2], LM:[4,2],
  RW:[0,3], RAM:[1,3], IR:[1,3], AM:[2,3], CF:[2,3], LAM:[3,3], IL:[3,3], LW:[4,3],
  OR:[0,4], RS:[1,4], ST:[2,4], LS:[3,4], OL:[4,4]
};
function meta(pos){ return POS_META[pos] || [2,2]; }

/* Greedy assignment of eleven players to eleven slots: stay in your
   channel first, shift a line second, travel distance breaks ties. */
function matchToTargets(players, targets){
  const n=targets.length;
  const C=[];
  players.forEach(function(p,pi){
    C[pi]=targets.map(function(t){
      const gkMismatch=(p.pos==="GK")!==(t.pos==="GK");
      if(gkMismatch) return 9999;
      const a=meta(p.pos), b=meta(t.pos);
      const dx=p.x-t.x, dy=p.y-t.y;
      const dl=Math.abs(a[1]-b[1]);
      return Math.abs(a[0]-b[0])*20 + dl*dl*18 + Math.sqrt(dx*dx+dy*dy)*0.35;
    });
  });
  // cheapest-pair-first, then swap any two players whenever trading
  // their slots costs less — greedy alone strands the odd man out.
  const pairs=[];
  for(let i=0;i<players.length;i++) for(let j=0;j<n;j++) pairs.push([i,j,C[i][j]]);
  pairs.sort(function(a,b){ return a[2]-b[2]; });
  const slotOf=new Array(players.length).fill(-1), taken=new Array(n).fill(false);
  pairs.forEach(function(pr){
    if(slotOf[pr[0]]>=0 || taken[pr[1]]) return;
    slotOf[pr[0]]=pr[1]; taken[pr[1]]=true;
  });
  for(let i=0;i<players.length;i++) if(slotOf[i]<0)
    for(let j=0;j<n;j++) if(!taken[j]){ slotOf[i]=j; taken[j]=true; break; }
  for(let pass=0; pass<6; pass++){
    let improved=false;
    for(let a=0;a<players.length;a++) for(let b=a+1;b<players.length;b++){
      const sa=slotOf[a], sb=slotOf[b];
      if(sa<0||sb<0) continue;
      if(C[a][sb]+C[b][sa] < C[a][sa]+C[b][sb] - 1e-6){
        slotOf[a]=sb; slotOf[b]=sa; improved=true;
      }
    }
    if(!improved) break;
  }
  const out=new Array(n);
  for(let i=0;i<players.length;i++) if(slotOf[i]>=0) out[slotOf[i]]=players[i];
  return out;
}

function teamSpaceToPitch(team,x,y){
  return team==="home" ? {x:x, y:y} : {x:100-x, y:100-y};
}
function buildPlayers(teamId, formation, xi){
  const slots = FORMATIONS[formation];
  return slots.map(function(s,i){
    const src = xi && xi[i] ? xi[i] : ["Player "+(i+1), i+1];
    const p = teamSpaceToPitch(teamId, s[2], s[3]);
    return { id:teamId+"-"+i, name:src[0], num:src[1], pos:s[0], role:s[1], x:p.x, y:p.y };
  });
}
function shapePositions(teamId, spec){
  const slots = FORMATIONS[spec.f];
  const base = spec.push || 0, sq = spec.squeeze == null ? 1 : spec.squeeze;
  const byRole = spec.pushByRole || {};
  return slots.map(function(s){
    const push = base + (byRole[s[1]] || 0);
    let x = s[2] + (s[1]==="GK" ? push*0.22 : push);
    if (s[1]==="GK") x = Math.min(x, 17);
    x = Math.max(2, Math.min(93, x));
    let y = 50 + (s[3]-50)*sq;
    y = Math.max(4, Math.min(96, y));
    const p = teamSpaceToPitch(teamId, x, y);
    return { pos:s[0], role:s[1], x:p.x, y:p.y };
  });
}

export {
  FORMATIONS, FORMATION_KEYS, CLUBS, kit,
  POS_META, meta, matchToTargets,
  SCRIPTED_PHASES, genericPhases,
  backThree, buildShape, pressShape, blockShape,
  teamSpaceToPitch, buildPlayers, shapePositions
};
