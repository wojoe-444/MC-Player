// Phrasings for the chat matcher tests. [text, expectedIntent | null, note?]
//   null     = must NOT be treated as a command (conversation, left to Claude)
//   'ask:X'  = recognised but must be confirmed first (high-risk / low-confidence), intent X
// REAL = lines Walter actually typed (chat.log, 2026-10-25). The rest are variants: typos, filler, slang, other wordings.

const REAL = [
  ['can you walk to me', 'come'],
  ['is your inventory empty?', 'inventory'],
  ['come here', 'come'],
  ['sleep', 'sleep'],
  ["let's sleep please", 'sleep'],
  ['we do need to sleep tonight', 'sleep'],
  ["It's spamming \"Here.\" in the chat quite a bit", null],
  ["I've given you cobblestone and wood, can you find a crafting table and make yourself a basic tool set?", null, 'compound request: left to Claude'],
  ["This is a room I'm building out, but I need to excavate the blocks above. Can you help? First I need to be sure you understand the room you're in", null],
  ['this is the room we need to excavate the ceiling from', null, 'statement mentioning room + excavate'],
  ["i don't have the exact area, but the open space you are in is clearly rectangular, so that is your guide. you are standing on the intended floor, and we want this room to have 6 blocks height carved out. that's your goal", null],
  ['When your inventory gets full, put all the cobblestone in one of the automatic furnaces.', null],
  ["Can you pause excavating and let's confirm you understand how to keep the automatic furnaces running", null, 'mixed request: left to Claude'],
  ['you should take a screenshot of the layout. the fuel chest is the one with lava buckets in it now. the input chest is up and to the left of it', null],
  ["yes there are two lava depots and two different auto-furnace stations. empty buckets end up in the output chests. i'd like you to have a routine you default to when not given tasks otherwise, and maintaining these furnaces in one task.", null],
  ['you would take empty buckets, fill them up at the lava depot, and then put them in the fuel input chest.', null, 'statement: must not ask "which lava depot"'],
  ["it's important that you not walk around with lava buckets as the selected item in your hand because that can be fraught", null],
  ["it's also important that you find a bed when it gets dark, then ping me if i'm not in bed as well. you should do this only once every 3 days since there's that mob that spawns if you don't sleep.", null],
  ['the lava is in cauldrons or something by theway', null],
  ["it's like the lava farms where calcimites or something (the ones that drip) drip into cauldrons. so you know which blocks to look up", null],
  ["you'll need to monitor your hunger and keep some food on you too, generally about 1 stack. can you come meet me where I am now, at the farm?", 'goto-waypoint', 'last sentence is the order'],
  ['make sure you replant whatever you take from here. carrots you can eat directly, wheat can become bread, et cetera.', null],
  ["you're welcome to take common crop food from chests, but in this case i'd like you to take from the farm so you can practice that skill", null],
  ['are you saving a persistent memory somewhere of locations you use?', null],
  ['do you monitor if you\'re ever causing a bunch of items to overflow and stay on the ground? that should be avoided', null],
  ["i'm struggling to find a bed or a chest with wool in it", null],
  ['and maybe you could work generally on how to improve the faster-responding parts of the bot, dispatching back to the central thread so it can get the features made while you drive the game', null],
  ['is this fun for you by the way?', null],
  ['is there any way to have you default to routine during undirected time? like maintaing the furnaces', null],
  ['does that mean 1836 days have gone by since i started the save', null],
  ["I'm out killing sheep for more wool so we can sleep tonight", null],
  ["oh, i had a bed in my own inventory. you may not be able to check that for me, but if you can i'd like it if you did", null],
  ['ok so i would have expected you, after waking, to default to your routine', null],
  ['if your furnace routine isn\'t ready yet, can you also get a farm routine going to harvest and replant crops? then store them in a chest in the house', null, 'compound: left to Claude'],
  ['it looked like you teleported there, make sure your movements are all survivor friendly', null]
]

const VARIANTS = [
  // follow
  ['follow me', 'follow'], ['can u pls folow me', 'follow'], ['hey ozogo444 follow me please', 'follow'], ['OzoGo444, follow me!!', 'follow'],
  ['follow', 'follow'], ['fllow me', 'follow'], ['followme', 'follow'], ['tag along', 'follow'], ['come with me', 'follow'], ['could you follow me for a sec', 'follow'],
  ['!follow', 'follow'], ['stick with me', 'follow'], ['follow me 🙂', 'follow'],
  // come
  ['come here!', 'come'], ['come here please', 'come'], ['cmere', 'come'], ['comere', 'come'], ['get over here', 'come'], ['come over here', 'come'],
  ['walk to me', 'come'], ['run to me', 'come'], ['meet me here', 'come'], ['could you come to me', 'come'], ['can you come here real quick', 'come'], ['come', 'come'],
  // stay / stop
  ['stay', 'stay'], ['stop', 'stay'], ['STOP', 'stay'], ['stpo', 'stay'], ['stahp', 'stay'], ['wait', 'stay'], ['hold on', 'stay'], ['halt!', 'stay'], ['freeze', 'stay'],
  ['dont move', 'stay'], ["don't move", 'stay'], ['stay here', 'stay'], ['stop following me', 'stay'], ['pause', 'stay'], ['ok stop please', 'stay'], ['whoa stop', 'stay'],
  ['cancel that', 'stay'], ['never mind', 'stay'], ['hold up', 'stay'], ['pause excavating', 'stay'], ['stop digging', 'stay'], ['stop doing that', 'stay'], ['wait for me', 'stay'],
  ["don't follow me", 'stay'], ['dont come', 'stay'], ['stop right there', 'stay'], ['stop for a second', 'stay'],
  // inventory
  ['inventory', 'inventory'], ['inv', 'inventory'], ['invntory', 'inventory'], ['what are you carrying', 'inventory'], ['what do you have on you', 'inventory'], ["what's in your bag", 'inventory'],
  ['check your inventory please', 'inventory'], ['is your inventory full?', 'inventory'], ['show me your inventory', 'inventory'],
  ['do you have any torches?', 'inventory'], ['how many torches do you have', 'inventory'], ['got any cobblestone', 'inventory'], ['do you have a pickaxe', 'inventory'],
  // status
  ['status', 'status'], ['how are you', 'status'], ['how r u', 'status'], ['how are you doing?', 'status'], ['are you hungry?', 'status'], ['whats your health', 'status'], ['hp?', 'status'], ['sitrep', 'status'],
  ['give me an update', 'status'],
  // where
  ['where are you', 'where'], ['where r u', 'where'], ['your coordinates', 'where'], ['what are your coords', 'where'], ["what's ur position", 'where'], ['send me your coordinates', 'where'],
  // around / time / who
  ["what's around", 'around'], ['what do you see', 'around'], ['look around', 'around'], ['anything nearby?', 'around'], ['any zombies?', 'around'],
  ['what time is it', 'time'], ['is it night?', 'time'], ['how long until night', 'time'], ['time of day?', 'time'],
  ["who's nearby", 'who'], ['who is online', 'who'], ['anyone else here', 'who'],
  // sleep / wake
  ['go to bed', 'sleep'], ['time for bed', 'sleep'], ['go to sleep', 'sleep'], ['can you sleep now', 'sleep'], ['find a bed and sleep', 'sleep'], ['slepe', 'sleep'], ['wake up', 'wake'], ['get up', 'wake'],
  // waypoints list
  ['list waypoints', 'waypoints'], ['what waypoints do you have', 'waypoints'], ['show places', 'waypoints'], ['what places do you know', 'waypoints'],
  // look
  ['describe the room', 'room'], ['scan the room', 'room'], ['what room is this', 'room'], ['do you understand the room?', 'room'],
  ['scan furnaces', 'furnaces-scan'], ['where are the furnaces', 'furnaces-scan'],
  // jobs (high risk -> confirmed when not word-for-word)
  ['harvest', 'harvest'], ['harvest the crops', 'harvest'], ['harvet the crops', 'ask:harvest'], ['harvset the crops', 'ask:harvest'], ['indx chests', 'ask:index'], ['refuel the furnces', 'ask:furnace-start'], ['resume diging', 'ask:excavate-resume'], ['pick the crops', 'harvest'], ['get some food from the farm', 'harvest'],
  ['index chests', 'index'], ['read all the chests', 'index'], ['inspect the stations', 'inspect'],
  ['make yourself a basic tool set', 'craft'], ['craft tools', 'craft'], ['can you make yourself some tools?', 'craft'],
  ['keep the furnaces running', 'furnace-start'], ['refuel the furnaces', 'furnace-start'], ['start the furnace routine', 'furnace-start'],
  ['stop furnace upkeep', 'furnace-stop'], ['leave the furnaces alone', 'furnace-stop'], ['how are the furnaces', 'furnace-status'], ['how much lava is left', 'furnace-status'],
  ['resume digging', 'excavate-resume'], ['keep digging', 'excavate-resume'], ['start excavating', 'excavate-start'],
  ['how is the digging going', 'excavate-status'], ['excavation progress', 'excavate-status'],
  ['you can fight', 'fight-on'], ['defend yourself', 'fight-on'], ['dont fight', 'fight-off'], ['just warn me', 'fight-off'],
  ['what are you doing', 'queue'], ['are you busy?', 'queue'], ['any danger?', 'mobs'], ['is it safe', 'mobs'],
  ['help', 'hello'], ['what can you do', 'hello'], ['commands', 'hello'],
  ['farm routine on', 'farm-on'], ['farm routine off', 'farm-off'], ['store the crops', 'farm-store'],

  // not commands: questions about commands, past tense, chatter, negations
  ['how do i make you follow me', null], ['did you follow me', null], ['why did you stop', null], ['i told you to stop earlier', null],
  ['hello', 'hello'], ['hi', 'hello'], ['thanks', null], ['thank you!', null], ['lol', null], ['nice', null], ['ok', null], ['yes', null], ['no', null],
  ['i love this world', null], ['what a nice farm', null], ['good job', null], ['the stop sign is red', null],
  ["don't harvest anything yet", null], ['dont stop', null], ['no need to sleep', null],
  ['', null], ['   ', null], ['/gamemode creative', null], ['/stop', null]
]

module.exports = { REAL, VARIANTS }
