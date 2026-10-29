import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  X,
  Send,
  Users,
  Crown,
  Copy,
  Check,
  Share2,
  AlertCircle,
  Clock,
  Radio,
  LogOut,
  ShieldAlert,
  ShieldCheck,
  RefreshCw,
  Sparkles,
  Eye,
  Tv,
  MessageSquare,
  UserPlus,
} from 'lucide-react';
import { MatchRoom, ChatMessage, UserProfile, RoomViewer } from '../types.js';
import { authFetch, db } from '../lib/firebase.js';
import { collection, query, orderBy, limit, onSnapshot, doc } from 'firebase/firestore';
import { StreamPlayerArea } from './StreamPlayerArea.js';

interface RoomViewModalProps {
  room: MatchRoom | null;
  currentUser: UserProfile | null;
  onClose: () => void;
  onRoomUpdated: (updatedRoom: MatchRoom | null) => void;
}

export const RoomViewModal: React.FC<RoomViewModalProps> = ({
  room: initialRoom,
  currentUser,
  onClose,
  onRoomUpdated,
}) => {
  const [currentRoom, setCurrentRoom] = useState<MatchRoom | null>(initialRoom);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [activeTab, setActiveTab] = useState<'stream' | 'chat' | 'roster'>('stream');
  const [isClosingRoom, setIsClosingRoom] = useState(false);
  const [isJoiningSquad, setIsJoiningSquad] = useState(false);
  const [rateLimitCooldown, setRateLimitCooldown] = useState(0);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Sync internal room state with initial prop
  useEffect(() => {
    setCurrentRoom(initialRoom);
  }, [initialRoom]);

  // Auto-scroll to bottom of messages
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const roomId = currentRoom?.id;

  // 1. Real-time Room Document Listener (for broadcast state, status, viewer count)
  useEffect(() => {
    if (!roomId) return;

    let unsubscribe: (() => void) | null = null;
    try {
      const roomDocRef = doc(db, 'rooms', roomId);
      unsubscribe = onSnapshot(
        roomDocRef,
        (snapshot) => {
          if (snapshot.exists()) {
            const data = snapshot.data() as MatchRoom;
            setCurrentRoom(data);
            onRoomUpdated(data);
          } else {
            // Room was deleted or closed
            onRoomUpdated(null);
            onClose();
          }
        },
        (err) => {
          console.warn('[RoomViewModal] room doc listener note:', err.message);
        }
      );
    } catch (err) {
      console.warn('[RoomViewModal] room doc listener init error:', err);
    }

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [roomId, onRoomUpdated, onClose]);

  // 2. Real-time Messages Listener using Firestore onSnapshot
  useEffect(() => {
    if (!roomId) return;

    let unsubscribe: (() => void) | null = null;
    try {
      const messagesRef = collection(db, 'rooms', roomId, 'messages');
      const q = query(messagesRef, orderBy('createdAt', 'asc'), limit(100));

      unsubscribe = onSnapshot(
        q,
        (snapshot) => {
          const list: ChatMessage[] = [];
          snapshot.forEach((doc) => {
            list.push(doc.data() as ChatMessage);
          });
          setMessages(list);
          setTimeout(scrollToBottom, 50);
        },
        async (error) => {
          console.warn('[onSnapshot fallback to API poll]:', error.message);
          try {
            const res = await fetch(`/api/rooms/${roomId}/messages`);
            const data = await res.json();
            if (data.success && Array.isArray(data.messages)) {
              setMessages(data.messages);
              setTimeout(scrollToBottom, 50);
            }
          } catch (e) {
            // silent fallback
          }
        }
      );
    } catch (err: any) {
      console.warn('[RoomViewModal] onSnapshot setup error:', err);
    }

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [roomId]);

  // 3. Viewer Presence Heartbeat & Leave Lifecycle
  const sendViewerLeave = useCallback(() => {
    if (!roomId || !currentUser) return;
    try {
      // Use navigator.sendBeacon or fetch with keepalive to ensure clean disconnect
      const token = (currentUser as any)?.accessToken || '';
      const payload = JSON.stringify({});
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      fetch(`/api/rooms/${roomId}/viewers/leave`, {
        method: 'POST',
        headers,
        body: payload,
        keepalive: true,
      }).catch(() => {});
    } catch (e) {
      // silent catch on exit
    }
  }, [roomId, currentUser]);

  useEffect(() => {
    if (!roomId || !currentUser) return;

    // Send immediate heartbeat on room open
    const sendHeartbeat = async () => {
      try {
        await authFetch(`/api/rooms/${roomId}/viewers/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: currentUser.displayName || 'Player' }),
        });
      } catch (e) {
        // silent
      }
    };

    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 15000);

    const handleBeforeUnload = () => {
      sendViewerLeave();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      clearInterval(interval);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      sendViewerLeave();
    };
  }, [roomId, currentUser, sendViewerLeave]);

  // Rate-limit cooldown timer
  useEffect(() => {
    if (rateLimitCooldown <= 0) return;
    const timer = setInterval(() => {
      setRateLimitCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [rateLimitCooldown]);

  if (!currentRoom) return null;

  const isHost = currentUser?.id === currentRoom.hostId;
  const isParticipant = currentUser?.id ? Boolean(currentRoom.participants?.[currentUser.id]) : false;
  const participantList = Object.values(currentRoom.participants || {});
  const viewerList: RoomViewer[] = Object.values(currentRoom.activeViewers || {});

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) return;
    const text = inputText.trim();
    if (!text || isSending || rateLimitCooldown > 0) return;

    if (text.length > 300) {
      setChatError('Message exceeds 300 character limit.');
      return;
    }

    setIsSending(true);
    setChatError(null);

    try {
      const res = await authFetch(`/api/rooms/${currentRoom.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        if (res.status === 429) {
          setRateLimitCooldown(1);
          throw new Error('Please wait 1 second between messages.');
        }
        throw new Error(data.error || 'Failed to send message.');
      }

      setInputText('');
      setRateLimitCooldown(1);
      setTimeout(scrollToBottom, 50);
    } catch (err: any) {
      setChatError(err.message || 'Error sending message.');
    } finally {
      setIsSending(false);
    }
  };

  const handleJoinSquad = async () => {
    if (!currentUser) return;
    setIsJoiningSquad(true);
    try {
      const res = await authFetch(`/api/rooms/${currentRoom.id}/join`, {
        method: 'POST',
      });
      const data = await res.json();
      if (data.success && data.room) {
        setCurrentRoom(data.room);
        onRoomUpdated(data.room);
      }
    } catch (err: any) {
      console.warn('Failed to join squad:', err);
    } finally {
      setIsJoiningSquad(false);
    }
  };

  const handleCopyCode = () => {
    const code = currentRoom.id.replace('rm_', '').toUpperCase();
    navigator.clipboard.writeText(code);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleCopyLink = () => {
    const url = `${window.location.origin}?room=${currentRoom.id}`;
    navigator.clipboard.writeText(url);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const handleToggleLiveStatus = async () => {
    if (!isHost) return;
    const nextStatus = currentRoom.status === 'live' ? 'waiting' : 'live';

    try {
      const res = await authFetch(`/api/rooms/${currentRoom.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = await res.json();
      if (data.success && data.room) {
        setCurrentRoom(data.room);
        onRoomUpdated(data.room);
      }
    } catch (err) {
      console.warn('Failed to update room status:', err);
    }
  };

  const handleCloseRoom = async () => {
    if (!isHost) return;
    if (!window.confirm('Are you sure you want to conclude and close this match room?')) {
      return;
    }

    setIsClosingRoom(true);
    try {
      const res = await authFetch(`/api/rooms/${currentRoom.id}/close`, {
        method: 'POST',
      });
      const data = await res.json();
      if (data.success) {
        onRoomUpdated(null);
        onClose();
      }
    } catch (err) {
      console.warn('Failed to close room:', err);
    } finally {
      setIsClosingRoom(false);
    }
  };

  const handleLeaveRoom = async () => {
    try {
      await authFetch(`/api/rooms/${currentRoom.id}/leave`, {
        method: 'POST',
      });
      onClose();
    } catch (err) {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/90 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-4xl bg-[#0E121E] border border-white/[0.08] rounded-3xl overflow-hidden shadow-2xl flex flex-col h-[94vh] max-h-[820px]">
        {/* 1. Header Bar */}
        <div className="p-3.5 sm:p-4 border-b border-white/[0.06] bg-[#07090E]/90 shrink-0">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[10px] font-black uppercase tracking-wider text-emerald-400 font-mono px-2 py-0.5 rounded-md bg-emerald-950/70 border border-emerald-800/50 truncate">
                {currentRoom.gameTitle}
              </span>
              <span
                className={`text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 ${
                  currentRoom.status === 'live'
                    ? 'bg-rose-950 text-rose-300 border border-rose-800/60'
                    : 'bg-zinc-900 text-zinc-400 border border-zinc-800'
                }`}
              >
                {currentRoom.status === 'live' && (
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse" />
                )}
                <span>{currentRoom.status === 'live' ? 'Match Live' : 'Waiting for Squad'}</span>
              </span>

              {currentRoom.stream?.isLive && (
                <span className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded bg-rose-600 text-white font-mono flex items-center gap-1 shadow-sm">
                  <Tv className="w-2.5 h-2.5" />
                  <span>Broadcasting</span>
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="w-8 h-8 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white flex items-center justify-center transition-colors cursor-pointer shrink-0"
                aria-label="Close room modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="font-black text-sm sm:text-base text-white truncate flex items-center gap-2">
                <span>{currentRoom.title}</span>
              </h2>
              <div className="text-[11px] text-zinc-400 flex items-center gap-2 mt-0.5">
                <span className="flex items-center gap-1">
                  <Crown className="w-3 h-3 text-amber-400" />
                  <span>Host: {currentRoom.hostName}</span>
                </span>
                <span className="text-zinc-600">•</span>
                <span className="flex items-center gap-1 font-mono text-emerald-400">
                  <Eye className="w-3 h-3" />
                  <span>{currentRoom.viewerCount || 0} watching</span>
                </span>
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={handleCopyCode}
                className="px-2.5 py-1 rounded-lg bg-zinc-900 border border-white/10 hover:border-emerald-500/50 text-[11px] font-mono font-bold text-zinc-300 hover:text-white flex items-center gap-1 transition-all cursor-pointer"
                title="Copy Room Code"
              >
                {copiedCode ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span>{currentRoom.id.replace('rm_', '').toUpperCase()}</span>
              </button>

              <button
                type="button"
                onClick={handleCopyLink}
                className="p-1.5 rounded-lg bg-zinc-900 border border-white/10 hover:border-emerald-500/50 text-zinc-300 hover:text-white transition-all cursor-pointer"
                title="Copy Invite Link"
              >
                {copiedLink ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Share2 className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="flex items-center gap-1.5 sm:gap-2 mt-3 pt-2 border-t border-white/[0.04]">
            <button
              type="button"
              onClick={() => setActiveTab('stream')}
              className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer flex items-center justify-center gap-1.5 ${
                activeTab === 'stream'
                  ? 'bg-zinc-800 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Tv className="w-3.5 h-3.5 text-rose-400" />
              <span>Live Stream & Chat</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('chat')}
              className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer flex items-center justify-center gap-1.5 ${
                activeTab === 'chat'
                  ? 'bg-zinc-800 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <MessageSquare className="w-3.5 h-3.5 text-emerald-400" />
              <span>Chat ({messages.length})</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('roster')}
              className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer flex items-center justify-center gap-1.5 ${
                activeTab === 'roster'
                  ? 'bg-zinc-800 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Users className="w-3.5 h-3.5 text-indigo-400" />
              <span>
                Squad ({participantList.length}) • Viewers ({currentRoom.viewerCount || 0})
              </span>
            </button>
          </div>
        </div>

        {/* 2. Main Content Body according to Tab */}
        {activeTab === 'stream' && (
          <div className="flex-1 overflow-hidden flex flex-col md:flex-row min-h-0 bg-[#0A0D17]">
            {/* Left/Top: Gameplay Stream Viewport */}
            <div className="flex-1 flex flex-col p-3 sm:p-4 min-h-0 overflow-y-auto">
              <StreamPlayerArea
                room={currentRoom}
                currentUser={currentUser}
                onRoomUpdated={(upd) => {
                  setCurrentRoom(upd);
                  onRoomUpdated(upd);
                }}
              />

              {/* Stream Meta & Room Banner */}
              <div className="mt-3 p-3 rounded-2xl bg-zinc-900/60 border border-white/[0.04] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500/20 to-indigo-500/20 border border-white/10 flex items-center justify-center font-black text-xs text-white">
                    {currentRoom.hostName.slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <div className="text-xs font-bold text-white flex items-center gap-1">
                      <span>{currentRoom.hostName}</span>
                      <Crown className="w-3 h-3 text-amber-400" />
                    </div>
                    <div className="text-[10px] text-zinc-400">
                      Playing <span className="text-zinc-200 font-bold">{currentRoom.gameTitle}</span>
                    </div>
                  </div>
                </div>

                {!isParticipant && (
                  <button
                    type="button"
                    onClick={handleJoinSquad}
                    disabled={isJoiningSquad}
                    className="px-3 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black text-xs flex items-center gap-1.5 transition-all cursor-pointer shadow-md shadow-emerald-500/20"
                  >
                    <UserPlus className="w-3.5 h-3.5" />
                    <span>{isJoiningSquad ? 'Joining...' : 'Join Squad'}</span>
                  </button>
                )}
              </div>
            </div>

            {/* Right/Bottom: Docked Real-Time Chat Feed */}
            <div className="w-full md:w-80 lg:w-96 border-t md:border-t-0 md:border-l border-white/[0.06] flex flex-col min-h-[220px] md:min-h-0 bg-[#0E121E]">
              <div className="px-3 py-2 bg-zinc-900/50 border-b border-white/[0.04] text-[11px] font-bold text-zinc-300 flex items-center justify-between shrink-0">
                <span className="flex items-center gap-1.5">
                  <Sparkles className="w-3 h-3 text-emerald-400" />
                  <span>Live Stream Chat</span>
                </span>
                <span className="text-[10px] text-zinc-500 font-mono">
                  {messages.length} msgs
                </span>
              </div>

              {/* Messages list */}
              <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
                {messages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center p-4 text-zinc-500 space-y-1">
                    <Radio className="w-5 h-5 text-emerald-400/50" />
                    <div className="text-xs font-bold text-zinc-400">Chat Standby</div>
                    <p className="text-[10px]">No messages yet. Send a greeting to the stream squad!</p>
                  </div>
                ) : (
                  messages.map((msg) => {
                    const isMe = currentUser?.id === msg.senderId;
                    const isSenderHost = msg.senderId === currentRoom.hostId;
                    return (
                      <div
                        key={msg.id}
                        className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}
                      >
                        <div className="flex items-center gap-1 mb-0.5 px-1 text-[10px]">
                          <span className="font-bold text-zinc-400">
                            {isMe ? 'You' : msg.senderName}
                          </span>
                          {isSenderHost && (
                            <span className="text-[9px] font-bold text-amber-400 bg-amber-950/80 border border-amber-800/60 px-1 py-0.2 rounded flex items-center gap-0.5">
                              <Crown className="w-2 h-2" />
                              <span>Host</span>
                            </span>
                          )}
                          <span className="text-[8px] text-zinc-600 font-mono">
                            {new Date(msg.createdAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                        <div
                          className={`max-w-[88%] px-3 py-1.5 rounded-2xl text-xs leading-relaxed break-words shadow-sm ${
                            isMe
                              ? 'bg-emerald-600 text-white rounded-tr-sm'
                              : 'bg-zinc-800/90 text-zinc-200 border border-white/[0.04] rounded-tl-sm'
                          }`}
                        >
                          {msg.text}
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Chat Input */}
              <div className="p-2.5 border-t border-white/[0.06] bg-[#090C16] space-y-1 shrink-0">
                {chatError && (
                  <div className="px-2 py-1 rounded-md bg-rose-950/80 border border-rose-800 text-rose-300 text-[10px] flex items-center gap-1">
                    <AlertCircle className="w-3 h-3 shrink-0" />
                    <span>{chatError}</span>
                  </div>
                )}
                {rateLimitCooldown > 0 && (
                  <div className="text-[10px] text-amber-400 font-mono flex items-center gap-1 px-1">
                    <Clock className="w-2.5 h-2.5" />
                    <span>Slow mode: wait {rateLimitCooldown}s...</span>
                  </div>
                )}
                <form onSubmit={handleSendMessage} className="flex items-center gap-1.5">
                  <input
                    type="text"
                    placeholder={
                      isParticipant
                        ? 'Type a message (max 300 chars)...'
                        : 'Join squad to participate in chat...'
                    }
                    value={inputText}
                    onChange={(e) => {
                      setInputText(e.target.value);
                      setChatError(null);
                    }}
                    disabled={!isParticipant || isSending}
                    maxLength={300}
                    className="flex-1 bg-zinc-900 border border-white/[0.08] rounded-xl px-2.5 py-1.5 text-xs text-white placeholder:text-zinc-500 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
                  />
                  <button
                    type="submit"
                    disabled={!inputText.trim() || !isParticipant || isSending || rateLimitCooldown > 0}
                    className="w-8 h-8 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-zinc-950 flex items-center justify-center transition-all cursor-pointer shrink-0"
                  >
                    {isSending ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Send className="w-3.5 h-3.5" />
                    )}
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: Full Dedicated Chat Feed */}
        {activeTab === 'chat' && (
          <div className="flex-1 flex flex-col min-h-0 bg-[#0A0D17]">
            <div className="px-4 py-2 bg-zinc-900/60 border-b border-white/[0.04] text-[10px] text-zinc-400 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Sparkles className="w-3 h-3 text-emerald-400 shrink-0" />
                <span>Real-time text chat for match coordination & stream viewers</span>
              </span>
              <span className="text-zinc-500 font-mono">Phase 4.2</span>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-6 text-zinc-500 space-y-2">
                  <div className="w-10 h-10 rounded-xl bg-zinc-900 border border-white/5 flex items-center justify-center">
                    <Radio className="w-5 h-5 text-emerald-400/60" />
                  </div>
                  <div className="text-xs font-bold text-zinc-400">Squad Chat Ready</div>
                  <p className="text-[11px] max-w-xs">
                    Coordinate your match tactics, callouts, and voice links here.
                  </p>
                </div>
              ) : (
                messages.map((msg) => {
                  const isMe = currentUser?.id === msg.senderId;
                  const isSenderHost = msg.senderId === currentRoom.hostId;
                  return (
                    <div
                      key={msg.id}
                      className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}
                    >
                      <div className="flex items-center gap-1.5 mb-1 px-1">
                        <span className="text-[10px] font-bold text-zinc-400">
                          {isMe ? 'You' : msg.senderName}
                        </span>
                        {isSenderHost && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold text-amber-400 bg-amber-950/80 border border-amber-800/60 px-1 py-0.2 rounded">
                            <Crown className="w-2.5 h-2.5" />
                            <span>Host</span>
                          </span>
                        )}
                        <span className="text-[9px] text-zinc-600 font-mono">
                          {new Date(msg.createdAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                      <div
                        className={`max-w-[85%] px-3.5 py-2 rounded-2xl text-xs leading-relaxed break-words shadow-sm ${
                          isMe
                            ? 'bg-emerald-600 text-white rounded-tr-sm'
                            : 'bg-zinc-800/90 text-zinc-200 border border-white/[0.04] rounded-tl-sm'
                        }`}
                      >
                        {msg.text}
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Chat Input */}
            <div className="p-3 border-t border-white/[0.06] bg-[#0E121E] space-y-1.5 shrink-0">
              {chatError && (
                <div className="px-2.5 py-1 rounded-lg bg-rose-950/80 border border-rose-800/70 text-rose-300 text-[10px] flex items-center gap-1.5">
                  <AlertCircle className="w-3 h-3 shrink-0" />
                  <span>{chatError}</span>
                </div>
              )}
              {rateLimitCooldown > 0 && (
                <div className="text-[10px] text-amber-400 font-mono flex items-center gap-1 px-1">
                  <Clock className="w-2.5 h-2.5" />
                  <span>Slow mode: wait {rateLimitCooldown}s...</span>
                </div>
              )}
              <form onSubmit={handleSendMessage} className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder={
                    isParticipant
                      ? 'Type squad message (max 300 chars)...'
                      : 'Join room squad to participate in chat...'
                  }
                  value={inputText}
                  onChange={(e) => {
                    setInputText(e.target.value);
                    setChatError(null);
                  }}
                  disabled={!isParticipant || isSending}
                  maxLength={300}
                  className="flex-1 bg-zinc-900 border border-white/[0.08] rounded-xl px-3 py-2 text-xs text-white placeholder:text-zinc-500 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={!inputText.trim() || !isParticipant || isSending || rateLimitCooldown > 0}
                  className="w-9 h-9 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-zinc-950 flex items-center justify-center transition-all cursor-pointer shrink-0"
                >
                  {isSending ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                </button>
              </form>
            </div>
          </div>
        )}

        {/* Tab 3: Squad Participants & Real Viewers */}
        {activeTab === 'roster' && (
          <div className="flex-1 overflow-y-auto p-4 space-y-6 bg-[#0A0D17]">
            {/* Squad Members */}
            <div>
              <div className="text-xs font-black text-white flex items-center justify-between mb-2">
                <span className="flex items-center gap-1.5">
                  <Users className="w-4 h-4 text-emerald-400" />
                  <span>Squad Players ({participantList.length})</span>
                </span>
                <span className="text-[10px] text-zinc-500 font-mono">In-Room Roster</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {participantList.map((p) => (
                  <div
                    key={p.userId}
                    className="p-3 rounded-xl bg-zinc-900/80 border border-white/[0.06] flex items-center justify-between"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-xl bg-zinc-800 border border-white/10 flex items-center justify-center font-black text-xs text-white">
                        {p.displayName.slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <div className="font-bold text-xs text-white flex items-center gap-1.5">
                          <span>{p.displayName}</span>
                          {p.isHost && (
                            <span className="inline-flex items-center gap-0.5 text-[9px] font-bold text-amber-400 bg-amber-950 px-1 py-0.2 rounded border border-amber-800">
                              <Crown className="w-2.5 h-2.5" />
                              <span>Host</span>
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-zinc-500">
                          Joined {new Date(p.joinedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                    </div>

                    {currentUser?.id === p.userId && (
                      <span className="text-[10px] text-emerald-400 font-bold bg-emerald-950 px-2 py-0.5 rounded-full border border-emerald-800">
                        You
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Active Real Viewers Section */}
            <div>
              <div className="text-xs font-black text-white flex items-center justify-between mb-2">
                <span className="flex items-center gap-1.5">
                  <Eye className="w-4 h-4 text-indigo-400" />
                  <span>Active Real-Time Viewers ({viewerList.length})</span>
                </span>
                <span className="inline-flex items-center gap-1 text-[10px] font-mono text-emerald-400 bg-emerald-950/70 border border-emerald-800/40 px-2 py-0.5 rounded">
                  <ShieldCheck className="w-3 h-3" />
                  <span>0 Fake Viewers • Real-Time Heartbeat</span>
                </span>
              </div>

              {viewerList.length === 0 ? (
                <div className="p-4 rounded-xl bg-zinc-900/40 border border-white/5 text-center text-xs text-zinc-500">
                  No other viewers active currently.
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {viewerList.map((v) => (
                    <div
                      key={v.uid}
                      className="p-2.5 rounded-xl bg-zinc-900/60 border border-white/[0.04] flex items-center justify-between"
                    >
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                        <span className="text-xs font-bold text-zinc-200">{v.displayName}</span>
                      </div>
                      <span className="text-[9px] font-mono text-zinc-500">
                        Watching since{' '}
                        {new Date(v.joinedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 3. Footer Bar */}
        <div className="p-3 border-t border-white/[0.06] bg-[#07090E] flex items-center justify-between gap-2 shrink-0">
          {isHost ? (
            <>
              <button
                type="button"
                onClick={handleToggleLiveStatus}
                className={`px-3 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-1.5 ${
                  currentRoom.status === 'live'
                    ? 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
                    : 'bg-rose-600 text-white hover:bg-rose-500 shadow-lg shadow-rose-600/20'
                }`}
              >
                <Radio className="w-3.5 h-3.5" />
                <span>{currentRoom.status === 'live' ? 'Set to Waiting' : 'Mark Match Live'}</span>
              </button>

              <button
                type="button"
                onClick={handleCloseRoom}
                disabled={isClosingRoom}
                className="px-3 py-2 rounded-xl bg-zinc-900 border border-rose-800/60 hover:bg-rose-950 text-rose-300 font-bold text-xs transition-colors cursor-pointer flex items-center gap-1.5"
              >
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>{isClosingRoom ? 'Closing...' : 'Close Room'}</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={handleLeaveRoom}
              className="px-3 py-2 rounded-xl bg-zinc-900 border border-white/10 hover:bg-zinc-800 text-zinc-300 font-bold text-xs transition-colors cursor-pointer flex items-center gap-1.5 ml-auto"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Leave Room</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
