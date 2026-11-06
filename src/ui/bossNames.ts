/** Original epithets for the big monsters, shown on the objective bar and a Descent boss's entrance. */
export const BOSS_EPITHET: Record<string, string> = {
  treasureWyrm: 'Coiled Keeper of the Hoard',
  moltenColossus: 'Heart of the Sunken Forge',
  ossuaryKing: 'Lord of the Abyss',
};

/** What a Descent boss's fall leaves behind, under its name as it goes down. */
export const BOSS_FALL_LINE: Record<string, string> = {
  treasureWyrm: 'The hoard lies open',
  moltenColossus: 'The forge goes cold',
  ossuaryKing: 'The Abyss is broken',
};

/** What the herald calls out as a Descent boss calls up its adds: its first call, then its second. */
export const BOSS_CALL_LINE: Record<string, readonly [string, string]> = {
  treasureWyrm: ['The Wyrm calls its brood!', 'More of its brood claw up from the hoard!'],
  moltenColossus: ['The Colossus calls up the dead of the forge!', 'The forge gives up more of its dead!'],
  ossuaryKing: ['The King summons his court!', 'His court rises again! Break them!'],
};
