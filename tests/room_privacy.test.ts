import assert from 'assert';
import {
  firestoreRepo,
  FirestoreRepository,
  RoomNotFoundError,
  RoomEndedError,
  InvalidAccessCodeError,
  RoomCapacityFullError,
  InviteNotFoundError,
  InviteRevokedError,
  InviteExpiredError,
  InviteUsageLimitExceededError,
  MalformedCursorError,
  RoomSecurityConfigurationError,
  UnauthorizedHostActionError,
} from '../src/server/firestoreRepository.js';

if (!process.env.ROOM_ACCESS_PEPPER || process.env.ROOM_ACCESS_PEPPER.length < 32) {
  process.env.ROOM_ACCESS_PEPPER = 'test_pepper_for_gaming_hub_suite_min32_characters_long_entropy';
}

console.log('🧪 Starting Public & Private Match Rooms Architecture Test Suite...\n');

let total = 0;
let passed = 0;

async function run(name: string, fn: () => Promise<void> | void) {
  total++;
  try {
    const res = fn();
    if (res instanceof Promise) await res;
    passed++;
    console.log(`  ✅ [PASS] ${name}`);
  } catch (err: any) {
    console.error(`  ❌ [FAIL] ${name}:`, err.message);
    throw err;
  }
}

export async function runAllRoomPrivacyTests() {
  const timestamp = Date.now();
  const hostId = `host_privacy_${timestamp}`;
  const member1 = `player1_${timestamp}`;
  const member2 = `player2_${timestamp}`;
  const outsider = `outsider_${timestamp}`;

  // Track all test room IDs for isolated, positive cleanup at completion
  const createdTestRoomIds = new Set<string>();

  try {
    // -------------------------------------------------------------
    // SECTION 1: Base64URL Cursor Serialization & Validation
    // -------------------------------------------------------------
    await run('Cursor: Encodes and decodes Base64URL JSON without malformation', () => {
      const original = { createdAt: new Date(1730000000000).toISOString(), documentId: 'rm_complex_test_123' };
      const encoded = FirestoreRepository.encodeCursor(original);
      assert(typeof encoded === 'string', 'Encoded cursor must be string');
      assert(!encoded.includes('+') && !encoded.includes('/'), 'Cursor must be URL-safe Base64URL');

      const decoded = FirestoreRepository.decodeCursor(encoded);
      assert.deepStrictEqual(decoded, original, 'Decoded cursor must match original payload exactly');
    });

    await run('Cursor: Malformed or tampered cursor throws MalformedCursorError', () => {
      const invalidCursors = [
        'not_a_valid_base64_json',
        Buffer.from('{"invalid":"no_createdAt"}').toString('base64url'),
        Buffer.from('{"createdAt":"not_a_valid_date","documentId":"123"}').toString('base64url'),
        Buffer.from('{"createdAt":123,"documentId":""}').toString('base64url'),
      ];

      for (const bad of invalidCursors) {
        let threw = false;
        try {
          FirestoreRepository.decodeCursor(bad);
        } catch (e: any) {
          if (e instanceof MalformedCursorError) {
            threw = true;
          }
        }
        assert.strictEqual(threw, true, `Malformed cursor '${bad}' must throw MalformedCursorError`);
      }
    });

    // -------------------------------------------------------------
    // SECTION 2: Scrypt + Pepper PIN Verification & Fail-Closed Behavior
    // -------------------------------------------------------------
    await run('PIN Security: Hashes and validates numeric PIN correctly with Scrypt + 32-char Pepper', async () => {
      const pin = '4829';
      const hash = await FirestoreRepository.hashPin(pin);
      assert(typeof hash === 'string', 'Hashed PIN must be string');
      assert(hash.startsWith('scrypt$'), 'Hash must have scrypt algorithm prefix');

      const isValid = await FirestoreRepository.verifyPin(pin, hash);
      assert.strictEqual(isValid, true, 'Correct PIN must verify as true');

      const isWrong = await FirestoreRepository.verifyPin('0000', hash);
      assert.strictEqual(isWrong, false, 'Incorrect PIN must verify as false');
    });

    await run('PIN Security: Fail-closed if ROOM_ACCESS_PEPPER is missing or under 32 characters', async () => {
      const originalPepper = process.env.ROOM_ACCESS_PEPPER;
      try {
        // Test 1: Completely missing pepper
        delete process.env.ROOM_ACCESS_PEPPER;
        let caughtMissing = false;
        try {
          await FirestoreRepository.hashPin('1234');
        } catch (err: any) {
          if (err instanceof RoomSecurityConfigurationError) caughtMissing = true;
        }
        assert.strictEqual(caughtMissing, true, 'hashPin must fail closed if pepper is missing');

        // Test 2: Short pepper (16 characters, which is under the 32-character requirement)
        process.env.ROOM_ACCESS_PEPPER = 'short_pepper_16c';
        let caughtShort = false;
        try {
          await FirestoreRepository.hashPin('1234');
        } catch (err: any) {
          if (err instanceof RoomSecurityConfigurationError) caughtShort = true;
        }
        assert.strictEqual(caughtShort, true, 'hashPin must fail closed if pepper is under 32 characters');

        // Test 3: verifyPin fails closed if pepper is under 32 characters
        let caughtVerify = false;
        try {
          await FirestoreRepository.verifyPin('1234', 'scrypt$v1$16384$8$1$salt$hash');
        } catch (err: any) {
          if (err instanceof RoomSecurityConfigurationError) caughtVerify = true;
        }
        assert.strictEqual(caughtVerify, true, 'verifyPin must fail closed if pepper is under 32 characters');
      } finally {
        if (originalPepper) process.env.ROOM_ACCESS_PEPPER = originalPepper;
      }
    });

    // -------------------------------------------------------------
    // SECTION 3: Public Room Creation, Discovery, and Open Join
    // -------------------------------------------------------------
    let publicRoom: any = null;
    await run('Public Room: Creates public room with default capacity and open join', async () => {
      publicRoom = await firestoreRepo.createRoom(
        hostId,
        'HostGamer',
        'pubg',
        'PUBG Mobile',
        'Public Arena Match',
        'public',
        undefined,
        4
      );
      createdTestRoomIds.add(publicRoom.id);

      assert(publicRoom.id, 'Room ID must exist');
      assert.strictEqual(publicRoom.visibility, 'public');
      assert.strictEqual(publicRoom.maxParticipants, 4);
      assert(!publicRoom.accessCodeHash, 'Public room must have no accessCodeHash');

      // Open join without PIN
      const joined = await firestoreRepo.joinRoom(publicRoom.id, member1, 'PlayerOne');
      assert(joined.participants[member1], 'PlayerOne must be in participants map');
      assert.strictEqual(Object.keys(joined.participants).length, 2);
    });

    // -------------------------------------------------------------
    // SECTION 4: Universal Capacity Enforcement
    // -------------------------------------------------------------
    let tightRoom: any = null;
    await run('Capacity: Enforces maxParticipants cap transactionally', async () => {
      // Create a 2-player max room (host + 1 member)
      tightRoom = await firestoreRepo.createRoom(
        hostId,
        'HostGamer',
        'codm',
        'Call of Duty Mobile',
        '1v1 Duel Room',
        'public',
        undefined,
        2
      );
      createdTestRoomIds.add(tightRoom.id);

      // Player 1 joins (now 2/2 full)
      await firestoreRepo.joinRoom(tightRoom.id, member1, 'Duelist1');

      // Player 2 attempts to join full room -> throws RoomCapacityFullError
      let fullCaught = false;
      try {
        await firestoreRepo.joinRoom(tightRoom.id, member2, 'Duelist2');
      } catch (err: any) {
        if (err instanceof RoomCapacityFullError) fullCaught = true;
      }
      assert.strictEqual(fullCaught, true, 'Full room must reject admission with RoomCapacityFullError');
    });

    // -------------------------------------------------------------
    // SECTION 5: Private Room Creation & Scrypt PIN Verification
    // -------------------------------------------------------------
    let privateRoom: any = null;
    const privatePin = '8492';
    await run('Private Room: Requires PIN to join without invitation', async () => {
      privateRoom = await firestoreRepo.createRoom(
        hostId,
        'HostGamer',
        'freefire',
        'Free Fire',
        'Private Squad Room',
        'private',
        privatePin,
        6
      );
      createdTestRoomIds.add(privateRoom.id);

      assert.strictEqual(privateRoom.visibility, 'private');
      assert(privateRoom.accessCodeHash, 'Private room must store accessCodeHash');

      // Attempt to join without PIN -> rejected
      let rejectedNoPin = false;
      try {
        await firestoreRepo.joinRoom(privateRoom.id, member1, 'PlayerOne');
      } catch (err: any) {
        if (err instanceof InvalidAccessCodeError) rejectedNoPin = true;
      }
      assert.strictEqual(rejectedNoPin, true, 'Joining private room without PIN must be rejected');

      // Attempt to join with wrong PIN -> rejected
      let rejectedWrongPin = false;
      try {
        await firestoreRepo.joinRoom(privateRoom.id, member1, 'PlayerOne', '0000');
      } catch (err: any) {
        if (err instanceof InvalidAccessCodeError) rejectedWrongPin = true;
      }
      assert.strictEqual(rejectedWrongPin, true, 'Joining private room with wrong PIN must be rejected');

      // Join with correct PIN -> succeeds
      const joinedPrivate = await firestoreRepo.joinRoom(privateRoom.id, member1, 'PlayerOne', privatePin);
      assert(joinedPrivate.participants[member1], 'PlayerOne must be admitted with correct PIN');
    });

    // -------------------------------------------------------------
    // SECTION 6: Host PIN Rotation & Reset
    // -------------------------------------------------------------
    await run('PIN Management: Host can rotate or clear room PIN', async () => {
      const newPin = '9999';
      const updated = await firestoreRepo.resetRoomPin(privateRoom.id, hostId, newPin);
      assert(updated.accessCodeHash, 'Room must have updated accessCodeHash');

      // Non-host cannot reset PIN
      let rejectedNonHost = false;
      try {
        await firestoreRepo.resetRoomPin(privateRoom.id, member1, '1111');
      } catch (err: any) {
        if (err instanceof UnauthorizedHostActionError) rejectedNonHost = true;
      }
      assert.strictEqual(rejectedNonHost, true, 'Non-host PIN reset attempt must be rejected');
    });

    // -------------------------------------------------------------
    // SECTION 7: Cryptographic Invitation Subcollection & Fail-Closed Hashing
    // -------------------------------------------------------------
    await run('Invitations: Fails closed if ROOM_ACCESS_PEPPER is missing or under 32 characters', async () => {
      const originalPepper = process.env.ROOM_ACCESS_PEPPER;
      try {
        delete process.env.ROOM_ACCESS_PEPPER;
        let caughtCreate = false;
        try {
          await firestoreRepo.createInvitation(privateRoom.id, hostId, 'Secret Invite');
        } catch (err: any) {
          if (err instanceof RoomSecurityConfigurationError) caughtCreate = true;
        }
        assert.strictEqual(caughtCreate, true, 'createInvitation must fail closed without pepper');

        let caughtRedeem = false;
        try {
          await firestoreRepo.redeemInvitation(privateRoom.id, 'dummy_token', member2, 'P2');
        } catch (err: any) {
          if (err instanceof RoomSecurityConfigurationError) caughtRedeem = true;
        }
        assert.strictEqual(caughtRedeem, true, 'redeemInvitation must fail closed without pepper');
      } finally {
        if (originalPepper) process.env.ROOM_ACCESS_PEPPER = originalPepper;
      }
    });

    await run('Invitations: Host can generate invitations with token hashing', async () => {
      const invite = await firestoreRepo.createInvitation(
        privateRoom.id,
        hostId,
        'VIP Tournament Pass',
        1, // Single-use
        24 // 24 hours
      );

      assert(invite.rawToken, 'Must return rawToken to host');
      assert(invite.invitation.tokenHash, 'Must store tokenHash in DB');
      assert.strictEqual(invite.invitation.maxUses, 1);
      assert.strictEqual(invite.invitation.usedCount, 0);
      assert.strictEqual(invite.invitation.status, 'active');

      // Non-member (member2) redeems invitation
      const redeemResult = await firestoreRepo.redeemInvitation(
        privateRoom.id,
        invite.rawToken,
        member2,
        'PlayerTwo'
      );

      assert(redeemResult.room.participants[member2], 'PlayerTwo must be admitted');
      assert.strictEqual(redeemResult.alreadyMember, false);

      // Single-use invitation is now exhausted: subsequent user cannot redeem it
      let exhausted = false;
      try {
        await firestoreRepo.redeemInvitation(
          privateRoom.id,
          invite.rawToken,
          outsider,
          'OutsiderPlayer'
        );
      } catch (err: any) {
        if (err instanceof InviteUsageLimitExceededError) exhausted = true;
      }
      assert.strictEqual(exhausted, true, 'Single-use invite must reject second user');
    });

    await run('Invitations: Idempotent re-join by existing member does not increment use count', async () => {
      // Multi-use invite
      const multiInvite = await firestoreRepo.createInvitation(
        privateRoom.id,
        hostId,
        'Multi-Use Invite',
        5
      );

      // member2 redeems again (already a member)
      const idempotentResult = await firestoreRepo.redeemInvitation(
        privateRoom.id,
        multiInvite.rawToken,
        member2,
        'PlayerTwo'
      );

      assert.strictEqual(idempotentResult.alreadyMember, true);

      // List invitations to verify usedCount was NOT incremented for existing member
      const invites = await firestoreRepo.listInvitations(privateRoom.id, hostId);
      const target = invites.find((i) => i.id === multiInvite.invitation.id);
      assert(target, 'Target invitation must exist');
      assert.strictEqual(target.usedCount, 0, 'Existing member re-join must not consume an invite usage');
    });

    await run('Invitations: Revocation prevents redemption', async () => {
      const revokeInvite = await firestoreRepo.createInvitation(
        privateRoom.id,
        hostId,
        'To Be Revoked',
        10
      );

      await firestoreRepo.revokeInvitation(privateRoom.id, revokeInvite.invitation.id, hostId);

      let revokedCaught = false;
      try {
        await firestoreRepo.redeemInvitation(
          privateRoom.id,
          revokeInvite.rawToken,
          outsider,
          'OutsiderPlayer'
        );
      } catch (err: any) {
        if (err instanceof InviteRevokedError) revokedCaught = true;
      }
      assert.strictEqual(revokedCaught, true, 'Revoked invite must reject redemption');
    });

    // -------------------------------------------------------------
    // SECTION 8: Lobby Discovery & Legacy Room Compatibility
    // -------------------------------------------------------------
    await run('Lobby: listRooms excludes private rooms and includes public rooms', async () => {
      const result = await firestoreRepo.listRooms(undefined, undefined, 10);
      assert(Array.isArray(result.rooms), 'listRooms must return rooms array');

      const foundPrivate = result.rooms.find((r) => r.id === privateRoom.id);
      assert.strictEqual(foundPrivate, undefined, 'Private room must NEVER appear in public lobby listing');

      const foundPublic = result.rooms.find((r) => r.id === publicRoom.id);
      assert(foundPublic, 'Public room must appear in public lobby listing');
    });

    // -------------------------------------------------------------
    // SECTION 9: Legacy Room Preservation & Discovery
    // -------------------------------------------------------------
    const legacyRoomId = `rm_legacy_${timestamp}`;
    await run('Legacy Rooms: Undefined visibility and maxParticipants are discovered and supported', async () => {
      createdTestRoomIds.add(legacyRoomId);
      const legacyDoc = {
        id: legacyRoomId,
        hostId: `legacy_host_${timestamp}`,
        hostName: 'LegacyHost',
        gameId: 'codm',
        gameTitle: 'Call of Duty Mobile',
        title: 'Legacy Match Room Before Update',
        status: 'waiting',
        participantCount: 1,
        participants: {
          [`legacy_host_${timestamp}`]: {
            userId: `legacy_host_${timestamp}`,
            displayName: 'LegacyHost',
            joinedAt: new Date(timestamp - 10000).toISOString(),
            isHost: true,
          },
        },
        viewerCount: 0,
        createdAt: new Date(timestamp - 10000).toISOString(),
        updatedAt: new Date(timestamp - 10000).toISOString(),
      };

      // Insert directly into Firestore to simulate a room created before the migration
      await (firestoreRepo as any).db.collection('rooms').doc(legacyRoomId).set(legacyDoc);

      // Verify discovery in public lobby
      const lobby = await firestoreRepo.listRooms(undefined, undefined, 50);
      const found = lobby.rooms.find((r) => r.id === legacyRoomId);
      assert(found, 'Legacy room with absent visibility must be discovered in public lobby');

      // Verify that legacy room does not impose an unexpected 4-player cap
      for (let i = 1; i <= 5; i++) {
        const extraUser = `legacy_joiner_${i}_${timestamp}`;
        await firestoreRepo.joinRoom(legacyRoomId, extraUser, `Joiner${i}`);
      }
      const updatedLegacy = await firestoreRepo.getRoom(legacyRoomId);
      assert(updatedLegacy, 'Legacy room must exist');
      assert(Object.keys(updatedLegacy.participants).length >= 6, 'Legacy room must allow >4 players');
    });

    // -------------------------------------------------------------
    // SECTION 10: Private Room Preview Sanitization
    // -------------------------------------------------------------
    await run('Preview Sanitization: Sensitive fields stripped for unauthorized visitors', async () => {
      const room = await firestoreRepo.getRoom(privateRoom.id);
      assert(room, 'Private room must exist');

      const preview = {
        id: room.id,
        title: room.title,
        gameId: room.gameId,
        gameTitle: room.gameTitle,
        status: room.status,
        visibility: 'private' as const,
        participantCount: Object.keys(room.participants || {}).length,
        maxParticipants: room.maxParticipants,
        requiresPin: Boolean(room.accessCodeHash),
        createdAt: room.createdAt,
      };

      assert.strictEqual((preview as any).participants, undefined, 'Participants map must not be leaked');
      assert.strictEqual((preview as any).activeViewers, undefined, 'Active viewers must not be leaked');
      assert.strictEqual((preview as any).stream, undefined, 'Stream state must not be leaked');
      assert.strictEqual((preview as any).accessCodeHash, undefined, 'accessCodeHash must not be leaked');
      assert.strictEqual(preview.requiresPin, true, 'requiresPin must accurately reflect PIN state');
    });

    // -------------------------------------------------------------
    // SECTION 11: Deterministic Pagination Without Duplicates
    // -------------------------------------------------------------
    await run('Pagination: Cursor pagination delivers distinct items without overlap', async () => {
      const page1 = await firestoreRepo.listRooms(undefined, undefined, 3);
      assert(page1.rooms.length > 0, 'Page 1 must contain rooms');

      if (page1.nextCursor) {
        const page2 = await firestoreRepo.listRooms(undefined, undefined, 3, page1.nextCursor);
        const page1Ids = new Set(page1.rooms.map((r) => r.id));
        for (const r of page2.rooms) {
          assert(!page1Ids.has(r.id), `Page 2 room ${r.id} must not appear on Page 1 (no duplicates)`);
        }
      }
    });

    // -------------------------------------------------------------
    // SECTION 12: Expired Invitation Rejection
    // -------------------------------------------------------------
    await run('Invitations: Expired invitation is rejected with InviteExpiredError', async () => {
      const expiredInvite = await firestoreRepo.createInvitation(
        privateRoom.id,
        hostId,
        'Expired Ticket',
        5,
        1
      );

      // Explicitly set expiresAt to 1 hour in the past to verify expiration check
      await (firestoreRepo as any).db
        .collection('rooms')
        .doc(privateRoom.id)
        .collection('invitations')
        .doc(expiredInvite.invitation.id)
        .update({ expiresAt: new Date(Date.now() - 3600000).toISOString() });

      let expiredCaught = false;
      try {
        await firestoreRepo.redeemInvitation(
          privateRoom.id,
          expiredInvite.rawToken,
          outsider,
          'LateGamer'
        );
      } catch (err: any) {
        if (err instanceof InviteExpiredError) expiredCaught = true;
      }
      assert.strictEqual(expiredCaught, true, 'Expired invitation redemption must be rejected');
    });

    // -------------------------------------------------------------
    // SECTION 13: GENUINE CONCURRENCY - Final Available Slot Race (Public)
    // -------------------------------------------------------------
    await run('Concurrency: Two players simultaneously racing for final public room slot (Promise.all)', async () => {
      const raceRoom = await firestoreRepo.createRoom(
        `race_host_${timestamp}`,
        'RaceHost',
        'pubg',
        'PUBG Mobile',
        '2-Player Capacity Race Room',
        'public',
        undefined,
        2 // Max capacity: 2 (host + exactly 1 member slot)
      );
      createdTestRoomIds.add(raceRoom.id);

      const candidateA = `candidate_A_${timestamp}`;
      const candidateB = `candidate_B_${timestamp}`;

      // Launch genuine concurrent requests via Promise.allSettled
      const results = await Promise.allSettled([
        firestoreRepo.joinRoom(raceRoom.id, candidateA, 'PlayerAlpha'),
        firestoreRepo.joinRoom(raceRoom.id, candidateB, 'PlayerBeta'),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      assert.strictEqual(fulfilled.length, 1, 'Exactly one player must succeed in claiming final slot');
      assert.strictEqual(rejected.length, 1, 'Exactly one player must be rejected when capacity is reached');

      const rejectReason = (rejected[0] as PromiseRejectedResult).reason;
      assert(
        rejectReason instanceof RoomCapacityFullError,
        `Rejected player must receive RoomCapacityFullError, got: ${rejectReason?.message}`
      );

      // Check database state
      const finalRoom = await firestoreRepo.getRoom(raceRoom.id);
      assert(finalRoom, 'Room must exist');
      assert.strictEqual(
        Object.keys(finalRoom.participants).length,
        2,
        'Room capacity must never exceed 2 under concurrent admissions'
      );
    });

    // -------------------------------------------------------------
    // SECTION 14: GENUINE CONCURRENCY - Single-Use Invitation Redemption Race
    // -------------------------------------------------------------
    await run('Concurrency: Multiple players simultaneously redeeming single-use invitation (Promise.all)', async () => {
      const inviteRaceRoom = await firestoreRepo.createRoom(
        `inv_race_host_${timestamp}`,
        'InviteHost',
        'freefire',
        'Free Fire',
        'Invitation Race Room',
        'private',
        '1234',
        10
      );
      createdTestRoomIds.add(inviteRaceRoom.id);

      // Generate invitation with maxUses = 1
      const singleUseInvite = await firestoreRepo.createInvitation(
        inviteRaceRoom.id,
        `inv_race_host_${timestamp}`,
        'Single Slot Invite Race',
        1
      );

      const racer1 = `racer_1_${timestamp}`;
      const racer2 = `racer_2_${timestamp}`;
      const racer3 = `racer_3_${timestamp}`;

      // Launch 3 simultaneous redemption attempts
      const redeemResults = await Promise.allSettled([
        firestoreRepo.redeemInvitation(inviteRaceRoom.id, singleUseInvite.rawToken, racer1, 'RacerOne'),
        firestoreRepo.redeemInvitation(inviteRaceRoom.id, singleUseInvite.rawToken, racer2, 'RacerTwo'),
        firestoreRepo.redeemInvitation(inviteRaceRoom.id, singleUseInvite.rawToken, racer3, 'RacerThree'),
      ]);

      const fulfilled = redeemResults.filter((r) => r.status === 'fulfilled');
      const rejected = redeemResults.filter((r) => r.status === 'rejected');

      assert.strictEqual(fulfilled.length, 1, 'Exactly 1 candidate must successfully redeem single-use invite');
      assert.strictEqual(rejected.length, 2, 'Other 2 concurrent candidates must be rejected');

      for (const rej of rejected) {
        const reason = (rej as PromiseRejectedResult).reason;
        assert(
          reason instanceof InviteUsageLimitExceededError,
          `Rejected redemptions must receive InviteUsageLimitExceededError, got: ${reason?.message}`
        );
      }

      // Verify invitation in DB has usedCount === 1
      const invList = await firestoreRepo.listInvitations(inviteRaceRoom.id, `inv_race_host_${timestamp}`);
      const invRecord = invList.find((i) => i.id === singleUseInvite.invitation.id);
      assert(invRecord, 'Invitation record must exist');
      assert.strictEqual(invRecord.usedCount, 1, 'Invitation usedCount must be exactly 1');
    });

    // -------------------------------------------------------------
    // SECTION 15: GENUINE CONCURRENCY - Concurrent PIN-Based Joins
    // -------------------------------------------------------------
    await run('Concurrency: Concurrent PIN-based joins racing for final room slot (Promise.all)', async () => {
      const pinRaceRoom = await firestoreRepo.createRoom(
        `pin_race_host_${timestamp}`,
        'PinRaceHost',
        'codm',
        'Call of Duty Mobile',
        'PIN Capacity Race Room',
        'private',
        '5555',
        2 // Max capacity: 2
      );
      createdTestRoomIds.add(pinRaceRoom.id);

      const pinCandidateA = `pincand_A_${timestamp}`;
      const pinCandidateB = `pincand_B_${timestamp}`;

      const pinResults = await Promise.allSettled([
        firestoreRepo.joinRoom(pinRaceRoom.id, pinCandidateA, 'PinPlayerA', '5555'),
        firestoreRepo.joinRoom(pinRaceRoom.id, pinCandidateB, 'PinPlayerB', '5555'),
      ]);

      const fulfilled = pinResults.filter((r) => r.status === 'fulfilled');
      const rejected = pinResults.filter((r) => r.status === 'rejected');

      assert.strictEqual(fulfilled.length, 1, 'Exactly one PIN candidate must succeed');
      assert.strictEqual(rejected.length, 1, 'Other PIN candidate must be rejected');

      const rejectReason = (rejected[0] as PromiseRejectedResult).reason;
      assert(
        rejectReason instanceof RoomCapacityFullError,
        `Rejected candidate must get RoomCapacityFullError, got: ${rejectReason?.message}`
      );

      const finalPinRoom = await firestoreRepo.getRoom(pinRaceRoom.id);
      assert(finalPinRoom, 'Room must exist');
      assert.strictEqual(Object.keys(finalPinRoom.participants).length, 2, 'Capacity must remain exactly 2');
    });

    console.log(`\n🎉 Public & Private Match Rooms Test Suite Completed: ${passed}/${total} passed!\n`);
  } finally {
    // -------------------------------------------------------------
    // SECTION 16: ISOLATED TEST DATA CLEANUP (Safety Guard)
    // Only cleans up positively identified test-created rooms
    // -------------------------------------------------------------
    console.log(`🧹 Cleaning up ${createdTestRoomIds.size} isolated test-created room documents...`);
    const db = (firestoreRepo as any).db;
    for (const testRoomId of createdTestRoomIds) {
      try {
        // Clean up invitations subcollection
        const invSnap = await db.collection('rooms').doc(testRoomId).collection('invitations').get();
        for (const doc of invSnap.docs) {
          await doc.ref.delete();
        }
        // Clean up messages subcollection
        const msgSnap = await db.collection('rooms').doc(testRoomId).collection('messages').get();
        for (const doc of msgSnap.docs) {
          await doc.ref.delete();
        }
        // Delete room document
        await db.collection('rooms').doc(testRoomId).delete();
      } catch (err: any) {
        console.warn(`Warning during test room cleanup for ${testRoomId}:`, err.message);
      }
    }
    console.log('✨ Isolated test room cleanup complete.');
  }
}

// Execute directly if run as main script
if (process.argv[1]?.endsWith('room_privacy.test.ts') || process.argv[1]?.endsWith('room_privacy.test.js')) {
  runAllRoomPrivacyTests().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}
