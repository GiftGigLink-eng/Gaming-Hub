import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Radio,
  Tv,
  Volume2,
  VolumeX,
  Maximize2,
  Minimize2,
  Settings,
  ShieldCheck,
  AlertCircle,
  Play,
  Square,
  Users,
  Eye,
  Check,
  Info,
  RefreshCw,
  LogOut,
  Sliders,
  Wifi,
  Database,
  Smartphone,
  Mic,
} from 'lucide-react';
import {
  Room,
  RoomEvent,
  VideoQuality,
  Track,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteParticipant,
  ConnectionState,
} from 'livekit-client';
import { MatchRoom, UserProfile } from '../types.js';
import { authFetch } from '../lib/firebase.js';
import { nativeBroadcaster } from '../lib/nativeBroadcaster.js';

export type PlayerState =
  | 'idle'
  | 'connecting'
  | 'waiting_host'
  | 'playing'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

export type QualitySetting = 'auto' | 'low' | 'medium' | 'high';

interface StreamPlayerAreaProps {
  room: MatchRoom;
  currentUser: UserProfile | null;
  onRoomUpdated?: (updatedRoom: MatchRoom) => void;
}

export const StreamPlayerArea: React.FC<StreamPlayerAreaProps> = ({
  room,
  currentUser,
  onRoomUpdated,
}) => {
  // LiveKit Connection & Playback State
  const [playerState, setPlayerState] = useState<PlayerState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasActiveVideoTrack, setHasActiveVideoTrack] = useState<boolean>(false);
  const [selectedQuality, setSelectedQuality] = useState<QualitySetting>('auto');
  const [showQualityMenu, setShowQualityMenu] = useState(false);

  // Data Consumption Tracking (Clearly labeled as an estimate)
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [estimatedDataMB, setEstimatedDataMB] = useState(0);

  // Player Audio & Screen Controls
  const [isMuted, setIsMuted] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Host Direct Stream Controls (backward-compatible)
  const [showHostSettings, setShowHostSettings] = useState(false);
  const [streamUrlInput, setStreamUrlInput] = useState(room.stream?.streamUrl || '');
  const [streamProtocol, setStreamProtocol] = useState<'hls' | 'webrtc' | 'custom'>(
    room.stream?.protocol || 'hls'
  );
  const [isUpdatingBroadcast, setIsUpdatingBroadcast] = useState(false);
  const [broadcastError, setBroadcastError] = useState<string | null>(null);
  const [broadcastSuccess, setBroadcastSuccess] = useState<string | null>(null);

  // Native Android Broadcaster State
  const [androidQuality, setAndroidQuality] = useState<'auto' | '360p' | '480p' | '720p'>('auto');
  const [captureInternalAudio, setCaptureInternalAudio] = useState(true);
  const [isStartingAndroidBroadcast, setIsStartingAndroidBroadcast] = useState(false);
  const [androidBroadcastError, setAndroidBroadcastError] = useState<string | null>(null);
  const [androidBroadcastSuccess, setAndroidBroadcastSuccess] = useState<string | null>(null);
  const [isAndroidBroadcasting, setIsAndroidBroadcasting] = useState(false);

  // DOM Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const videoElementRef = useRef<HTMLVideoElement>(null);
  const audioElementRef = useRef<HTMLAudioElement>(null);
  const livekitRoomRef = useRef<Room | null>(null);
  const currentPublicationRef = useRef<RemoteTrackPublication | null>(null);

  const isHost = currentUser?.id === room.hostId;
  const directStreamLive = Boolean(room.stream?.isLive && room.stream?.streamUrl);

  // Sync direct stream input when room stream URL changes
  useEffect(() => {
    if (room.stream?.streamUrl) {
      setStreamUrlInput(room.stream.streamUrl);
    }
  }, [room.stream?.streamUrl]);

  // Fullscreen event listener
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (!isFullscreen) {
        if (containerRef.current?.requestFullscreen) {
          await containerRef.current.requestFullscreen();
          setIsFullscreen(true);
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
          setIsFullscreen(false);
        }
      }
    } catch (err) {
      console.warn('[StreamPlayerArea] Fullscreen toggle failed:', err);
    }
  };

  // Data usage estimator timer (Runs only while playing genuine video)
  useEffect(() => {
    if (playerState !== 'playing') return;

    const timer = setInterval(() => {
      setElapsedSeconds((prev) => {
        const next = prev + 1;
        // Estimated megabytes per second:
        // High (720p 2.5Mbps): ~0.31 MB/s (~19 MB/min)
        // Medium (480p 1.5Mbps): ~0.18 MB/s (~11 MB/min)
        // Low (360p 700kbps): ~0.09 MB/s (~5.5 MB/min)
        // Auto: ~0.20 MB/s (~12 MB/min)
        let ratePerSec = 0.2;
        if (selectedQuality === 'low') ratePerSec = 0.09;
        else if (selectedQuality === 'medium') ratePerSec = 0.18;
        else if (selectedQuality === 'high') ratePerSec = 0.31;

        setEstimatedDataMB(Number((next * ratePerSec).toFixed(1)));
        return next;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [playerState, selectedQuality]);

  // Apply video quality constraints to the subscribed remote video track
  const applyQuality = useCallback((publication: RemoteTrackPublication, quality: QualitySetting) => {
    if (!publication) return;
    try {
      if (quality === 'low') {
        publication.setVideoQuality(VideoQuality.LOW);
      } else if (quality === 'medium') {
        publication.setVideoQuality(VideoQuality.MEDIUM);
      } else if (quality === 'high') {
        publication.setVideoQuality(VideoQuality.HIGH);
      }
    } catch (err) {
      console.warn('[StreamPlayerArea] Failed to adjust video quality:', err);
    }
  }, []);

  const handleSelectQuality = (quality: QualitySetting) => {
    setSelectedQuality(quality);
    setShowQualityMenu(false);
    if (currentPublicationRef.current) {
      applyQuality(currentPublicationRef.current, quality);
    }
  };

  // Disconnect & release all LiveKit media resources
  const leaveLiveStream = useCallback(() => {
    if (livekitRoomRef.current) {
      try {
        livekitRoomRef.current.disconnect();
      } catch (err) {
        console.warn('[StreamPlayerArea] Error disconnecting room:', err);
      }
      livekitRoomRef.current = null;
    }

    if (videoElementRef.current) {
      videoElementRef.current.srcObject = null;
    }
    if (audioElementRef.current) {
      audioElementRef.current.srcObject = null;
    }

    currentPublicationRef.current = null;
    setHasActiveVideoTrack(false);
    setPlayerState('disconnected');
    setElapsedSeconds(0);
    setEstimatedDataMB(0);
  }, []);

  // Cleanup on unmount or room switch
  useEffect(() => {
    return () => {
      leaveLiveStream();
    };
  }, [leaveLiveStream, room.id]);

  // Connect to LiveKit Room as a Viewer (Strictly manual, no autoplay)
  const joinLiveKitRoom = async () => {
    if (!currentUser) {
      setErrorMessage('Please sign in to connect to the live stream.');
      setPlayerState('error');
      return;
    }

    setPlayerState('connecting');
    setErrorMessage(null);
    setElapsedSeconds(0);
    setEstimatedDataMB(0);

    try {
      // 1. Authenticate with server and fetch scoped subscribe-only token
      const res = await authFetch(`/api/rooms/${room.id}/livekit-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publish: false, // Viewers explicitly request subscribe-only access
        }),
      });

      const tokenData = await res.json();
      if (!res.ok || !tokenData.success) {
        throw new Error(tokenData.error || 'Failed to authenticate for live stream.');
      }

      // 2. Initialize LiveKit Client Room instance
      const lkRoom = new Room({
        adaptiveStream: selectedQuality === 'auto',
        dynacast: true,
      });

      livekitRoomRef.current = lkRoom;

      // 3. Register Event Listeners
      lkRoom.on(RoomEvent.Connected, () => {
        let activeVideoFound = false;

        // Inspect any existing publications from remote broadcasters
        lkRoom.remoteParticipants.forEach((participant: RemoteParticipant) => {
          participant.trackPublications.forEach((pub: RemoteTrackPublication) => {
            if (pub.track && pub.track.kind === Track.Kind.Video) {
              if (videoElementRef.current) {
                pub.track.attach(videoElementRef.current);
                currentPublicationRef.current = pub;
                applyQuality(pub, selectedQuality);
                activeVideoFound = true;
              }
            }
            if (pub.track && pub.track.kind === Track.Kind.Audio) {
              if (audioElementRef.current) {
                pub.track.attach(audioElementRef.current);
              }
            }
          });
        });

        if (activeVideoFound) {
          setHasActiveVideoTrack(true);
          setPlayerState('playing');
        } else {
          setHasActiveVideoTrack(false);
          setPlayerState('waiting_host');
        }
      });

      lkRoom.on(
        RoomEvent.TrackSubscribed,
        (track: RemoteTrack, publication: RemoteTrackPublication) => {
          if (track.kind === Track.Kind.Video) {
            if (videoElementRef.current) {
              track.attach(videoElementRef.current);
              currentPublicationRef.current = publication;
              applyQuality(publication, selectedQuality);
            }
            setHasActiveVideoTrack(true);
            setPlayerState('playing');
          } else if (track.kind === Track.Kind.Audio) {
            if (audioElementRef.current) {
              track.attach(audioElementRef.current);
            }
          }
        }
      );

      lkRoom.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        track.detach();

        // Check if any video track remains active
        let anyVideoRemaining = false;
        lkRoom.remoteParticipants.forEach((participant: RemoteParticipant) => {
          participant.trackPublications.forEach((pub: RemoteTrackPublication) => {
            if (pub.track && pub.track.kind === Track.Kind.Video) {
              anyVideoRemaining = true;
            }
          });
        });

        if (!anyVideoRemaining) {
          setHasActiveVideoTrack(false);
          setPlayerState('waiting_host');
        }
      });

      lkRoom.on(RoomEvent.Reconnecting, () => {
        setPlayerState('reconnecting');
      });

      lkRoom.on(RoomEvent.Reconnected, () => {
        setPlayerState(hasActiveVideoTrack ? 'playing' : 'waiting_host');
      });

      lkRoom.on(RoomEvent.Disconnected, () => {
        setHasActiveVideoTrack(false);
        setPlayerState('disconnected');
      });

      // 4. Connect over WebRTC
      await lkRoom.connect(tokenData.serverUrl, tokenData.token);
    } catch (err: any) {
      console.error('[StreamPlayerArea] Connection error:', err);
      setPlayerState('error');
      setErrorMessage(err.message || 'Unable to establish WebRTC connection to live stream.');
    }
  };

  // Host Action: Update Broadcast Metadata / Direct Stream (HLS/WebRTC)
  const handleUpdateBroadcast = async (nextLiveState: boolean, overrideUrl?: string) => {
    if (!isHost) return;
    setIsUpdatingBroadcast(true);
    setBroadcastError(null);
    setBroadcastSuccess(null);

    const targetUrl = overrideUrl !== undefined ? overrideUrl : streamUrlInput.trim();

    if (nextLiveState && !targetUrl) {
      setBroadcastError('Please provide a valid stream URL (https://...) to start broadcasting.');
      setIsUpdatingBroadcast(false);
      return;
    }

    try {
      const res = await authFetch(`/api/rooms/${room.id}/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          isLive: nextLiveState,
          streamUrl: nextLiveState ? targetUrl : null,
          protocol: streamProtocol,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to update broadcast status.');
      }

      setBroadcastSuccess(
        nextLiveState ? 'Broadcast is now LIVE for viewers.' : 'Broadcast stopped.'
      );
      if (onRoomUpdated && data.room) {
        onRoomUpdated(data.room);
      }
      if (!nextLiveState) {
        setShowHostSettings(false);
      }
    } catch (err: any) {
      setBroadcastError(err.message || 'Error updating broadcast.');
    } finally {
      setIsUpdatingBroadcast(false);
    }
  };

  // Host Action: Test video helper
  const handleUseSampleStream = () => {
    const sampleHls =
      'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
    setStreamUrlInput(sampleHls);
    handleUpdateBroadcast(true, sampleHls);
  };

  // Host Action: Start Native Android Gameplay Broadcast
  const handleStartAndroidBroadcast = async () => {
    if (!isHost) return;
    setIsStartingAndroidBroadcast(true);
    setAndroidBroadcastError(null);
    setAndroidBroadcastSuccess(null);

    try {
      // 1. Request secure publisher token from server
      const tokenRes = await authFetch(`/api/rooms/${room.id}/livekit-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publish: true }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.success) {
        throw new Error(tokenData.error || 'Failed to acquire host broadcasting token.');
      }

      // 2. Request Android MediaProjection and start foreground capture
      const nativeResult = await nativeBroadcaster.startNativeBroadcast({
        roomId: room.id,
        token: tokenData.token,
        serverUrl: tokenData.serverUrl,
        quality: androidQuality,
        captureInternalAudio,
        gameTitle: room.gameTitle,
      });

      if (!nativeResult.success) {
        throw new Error(nativeResult.error || 'Android screen capture initiation failed.');
      }

      // 3. Mark broadcast live in Firestore room state
      const broadcastRes = await authFetch(`/api/rooms/${room.id}/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          isLive: true,
          streamUrl: tokenData.serverUrl,
          protocol: 'webrtc',
        }),
      });
      const broadcastData = await broadcastRes.json();
      if (broadcastData.room && onRoomUpdated) {
        onRoomUpdated(broadcastData.room);
      }

      setIsAndroidBroadcasting(true);
      setAndroidBroadcastSuccess('Android gameplay broadcast active. Foreground service running.');
    } catch (err: any) {
      setAndroidBroadcastError(err.message || 'Error starting Android gameplay broadcast.');
    } finally {
      setIsStartingAndroidBroadcast(false);
    }
  };

  // Host Action: Stop Native Android Broadcast
  const handleStopAndroidBroadcast = async () => {
    setIsStartingAndroidBroadcast(true);
    setAndroidBroadcastError(null);
    try {
      await nativeBroadcaster.stopNativeBroadcast();
      const broadcastRes = await authFetch(`/api/rooms/${room.id}/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          isLive: false,
          streamUrl: null,
          protocol: 'webrtc',
        }),
      });
      const broadcastData = await broadcastRes.json();
      if (broadcastData.room && onRoomUpdated) {
        onRoomUpdated(broadcastData.room);
      }
      setIsAndroidBroadcasting(false);
      setAndroidBroadcastSuccess('Broadcast stopped and MediaProjection resources released.');
    } catch (err: any) {
      setAndroidBroadcastError(err.message || 'Error stopping Android broadcast.');
    } finally {
      setIsStartingAndroidBroadcast(false);
    }
  };

  // Toggle Mute
  const handleToggleMute = () => {
    setIsMuted((prev) => {
      const next = !prev;
      if (videoElementRef.current) videoElementRef.current.muted = next;
      if (audioElementRef.current) audioElementRef.current.muted = next;
      return next;
    });
  };

  const isLiveStreamActive = playerState === 'playing' && hasActiveVideoTrack;
  const isDirectHlsActive = directStreamLive && playerState === 'idle';

  return (
    <div
      ref={containerRef}
      className={`relative w-full bg-black rounded-2xl overflow-hidden border border-white/[0.08] flex flex-col group select-none shadow-2xl ${
        isFullscreen ? 'h-screen rounded-none' : 'aspect-video'
      }`}
    >
      {/* 1. Main Viewport Area */}
      <div className="relative w-full h-full flex items-center justify-center bg-[#07090E] overflow-hidden">
        {/* Hidden Audio Element for remote track playback */}
        <audio ref={audioElementRef} autoPlay playsInline muted={isMuted} />

        {/* LiveKit Video Element (Only rendered active when genuinely streaming) */}
        <video
          ref={videoElementRef}
          autoPlay
          playsInline
          muted={isMuted}
          className={`w-full h-full object-contain bg-black transition-opacity duration-300 ${
            isLiveStreamActive ? 'opacity-100' : 'opacity-0 absolute pointer-events-none'
          }`}
        />

        {/* Fallback Direct Video (If host configured a direct HLS / sample stream) */}
        {isDirectHlsActive && !isLiveStreamActive && (
          <video
            src={room.stream?.streamUrl || ''}
            autoPlay
            playsInline
            muted={isMuted}
            loop
            className="w-full h-full object-contain bg-black"
          />
        )}

        {/* State A: Idle State (No Autoplay — Viewer in full control) */}
        {playerState === 'idle' && !isDirectHlsActive && (
          <div className="w-full h-full flex flex-col items-center justify-center p-6 text-center bg-gradient-to-b from-[#0F1424] via-[#090C16] to-[#05070B] relative">
            <div className="w-16 h-16 rounded-2xl bg-zinc-900 border border-emerald-500/30 flex items-center justify-center mb-3 shadow-xl shadow-emerald-950/40">
              <Tv className="w-8 h-8 text-emerald-400" />
            </div>

            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-zinc-900 border border-white/10 text-zinc-300 text-[11px] font-bold uppercase tracking-wider mb-2 font-mono">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              <span>{room.gameTitle} • Live Match Room</span>
            </div>

            <h3 className="text-base sm:text-lg font-black text-white tracking-tight mb-1">
              {room.title}
            </h3>

            <p className="text-xs text-zinc-400 max-w-sm mb-4 leading-relaxed">
              Connect to the live WebRTC stream to watch gameplay transmitted by{' '}
              <span className="text-white font-bold">{room.hostName}</span>. No autoplay is used to save your mobile data.
            </p>

            <div className="flex flex-col sm:flex-row items-center gap-2 mb-3">
              <button
                type="button"
                onClick={joinLiveKitRoom}
                className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black text-xs sm:text-sm flex items-center gap-2 shadow-lg shadow-emerald-500/20 transition-all cursor-pointer active:scale-95"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>Watch Live Stream</span>
              </button>

              <div className="inline-flex items-center gap-1 px-3 py-2 rounded-xl bg-zinc-900/80 border border-white/5 text-[11px] text-zinc-400 font-mono">
                <Database className="w-3.5 h-3.5 text-emerald-400" />
                <span>Est. ~10–19 MB/min</span>
              </div>
            </div>

            <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-zinc-900/70 border border-white/5 text-[10px] text-zinc-500 font-mono">
              <ShieldCheck className="w-3 h-3 text-emerald-400" />
              <span>Genuine WebRTC stream • Authenticated subscriber token</span>
            </div>
          </div>
        )}

        {/* State B: Connecting State */}
        {playerState === 'connecting' && (
          <div className="w-full h-full flex flex-col items-center justify-center p-6 text-center bg-[#07090E]">
            <RefreshCw className="w-10 h-10 text-emerald-400 animate-spin mb-3" />
            <h4 className="text-sm font-bold text-white mb-1">Connecting to LiveKit Room...</h4>
            <p className="text-xs text-zinc-400 font-mono">
              Securing room token & establishing WebRTC peer connection
            </p>
          </div>
        )}

        {/* State C: Waiting for Host State (Connected to room, but host not publishing video yet) */}
        {playerState === 'waiting_host' && (
          <div className="w-full h-full flex flex-col items-center justify-center p-6 text-center bg-gradient-to-b from-[#0F1424] via-[#090C16] to-[#05070B] relative">
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-20">
              <div className="w-48 h-48 rounded-full border border-emerald-500/30 animate-ping duration-1000" />
              <div className="w-72 h-72 rounded-full border border-emerald-500/20" />
            </div>

            <div className="relative z-10 flex flex-col items-center max-w-sm">
              <div className="w-14 h-14 rounded-2xl bg-zinc-900/90 border border-emerald-500/30 flex items-center justify-center mb-3 shadow-lg shadow-emerald-950/40">
                <Radio className="w-7 h-7 text-emerald-400 animate-pulse" />
              </div>

              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-950/80 border border-emerald-700/50 text-emerald-300 text-[11px] font-bold uppercase tracking-wider mb-2 font-mono">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>LiveKit Connected • Stream Standby</span>
              </div>

              <h3 className="text-sm sm:text-base font-black text-white tracking-tight mb-1">
                Waiting for host to broadcast gameplay
              </h3>

              <p className="text-[11px] sm:text-xs text-zinc-400 leading-relaxed mb-4">
                You are securely connected to the live room. As soon as{' '}
                <span className="text-white font-bold">{room.hostName}</span> begins transmitting their screen, the video will appear automatically.
              </p>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={leaveLiveStream}
                  className="px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-bold text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Leave Stream</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* State D: Reconnecting State */}
        {playerState === 'reconnecting' && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/85 backdrop-blur-sm text-center p-4">
            <Wifi className="w-8 h-8 text-amber-400 animate-pulse mb-2" />
            <h4 className="text-sm font-bold text-white mb-1">Reconnecting to Stream...</h4>
            <p className="text-xs text-zinc-400 max-w-xs">
              Mobile connection interrupted. Recovering WebRTC packet sync...
            </p>
          </div>
        )}

        {/* State E: Disconnected State */}
        {playerState === 'disconnected' && (
          <div className="w-full h-full flex flex-col items-center justify-center p-6 text-center bg-[#07090E]">
            <LogOut className="w-8 h-8 text-zinc-500 mb-2" />
            <h4 className="text-sm font-bold text-white mb-1">Stream Disconnected</h4>
            <p className="text-xs text-zinc-400 mb-3">
              Media resources and peer connections were cleanly released.
            </p>
            <button
              type="button"
              onClick={joinLiveKitRoom}
              className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black text-xs flex items-center gap-1.5 transition-all cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Reconnect</span>
            </button>
          </div>
        )}

        {/* State F: Error State */}
        {playerState === 'error' && (
          <div className="w-full h-full flex flex-col items-center justify-center p-6 text-center bg-[#0F080A]">
            <AlertCircle className="w-9 h-9 text-rose-400 mb-2" />
            <h4 className="text-sm font-bold text-white mb-1">Connection Notice</h4>
            <p className="text-xs text-rose-300 max-w-sm mb-4">{errorMessage}</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={joinLiveKitRoom}
                className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white font-bold text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Retry Connection</span>
              </button>
              <button
                type="button"
                onClick={() => setPlayerState('idle')}
                className="px-3 py-2 rounded-xl bg-zinc-900 text-zinc-400 hover:text-white text-xs cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* 2. Top Stream Info Overlay */}
        <div className="absolute top-0 inset-x-0 p-3 bg-gradient-to-b from-black/85 via-black/40 to-transparent flex items-center justify-between pointer-events-none z-20">
          <div className="flex items-center gap-2 pointer-events-auto">
            {isLiveStreamActive || isDirectHlsActive ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rose-600 text-white text-[10px] font-black uppercase tracking-wider shadow-lg shadow-rose-600/30">
                <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                <span>LIVE</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-zinc-800/90 text-zinc-300 text-[10px] font-bold border border-white/10">
                <Tv className="w-3 h-3 text-zinc-400" />
                <span>{playerState === 'waiting_host' ? 'STANDBY' : 'OFF-AIR'}</span>
              </span>
            )}

            <div className="px-2 py-0.5 rounded-md bg-black/60 backdrop-blur-md border border-white/10 text-[10px] font-bold text-zinc-300 flex items-center gap-1.5">
              <Eye className="w-3 h-3 text-emerald-400" />
              <span>{room.viewerCount || 0}</span>
              <span className="text-zinc-500 hidden sm:inline">viewing</span>
            </div>

            {/* Estimated Data Usage Badge (When playing) */}
            {isLiveStreamActive && (
              <div
                className="px-2 py-0.5 rounded-md bg-black/60 backdrop-blur-md border border-white/10 text-[10px] font-mono text-emerald-300 flex items-center gap-1"
                title="Estimated data consumption based on stream bitrate. Actual carrier billing may vary."
              >
                <Database className="w-3 h-3 text-emerald-400" />
                <span>~{estimatedDataMB.toFixed(1)} MB</span>
                <span className="text-zinc-500 text-[9px]">(Estimated)</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1.5 pointer-events-auto">
            {/* Quality Selector */}
            {isLiveStreamActive && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowQualityMenu((prev) => !prev)}
                  className="px-2 py-1 rounded-lg bg-black/60 backdrop-blur-md border border-white/10 hover:bg-zinc-800 text-[11px] font-bold text-zinc-300 hover:text-white transition-all cursor-pointer flex items-center gap-1"
                  title="Select video quality"
                >
                  <Sliders className="w-3 h-3 text-emerald-400" />
                  <span className="uppercase text-[10px]">{selectedQuality}</span>
                </button>

                {showQualityMenu && (
                  <div className="absolute right-0 mt-1 w-36 bg-[#0E121E] border border-white/10 rounded-xl p-1 shadow-2xl z-40 text-xs font-sans">
                    <button
                      type="button"
                      onClick={() => handleSelectQuality('auto')}
                      className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center justify-between cursor-pointer ${
                        selectedQuality === 'auto'
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'text-zinc-300 hover:bg-zinc-800'
                      }`}
                    >
                      <span>Auto (ABR)</span>
                      {selectedQuality === 'auto' && <Check className="w-3 h-3" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSelectQuality('low')}
                      className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center justify-between cursor-pointer ${
                        selectedQuality === 'low'
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'text-zinc-300 hover:bg-zinc-800'
                      }`}
                    >
                      <span>360p (Data Saver)</span>
                      {selectedQuality === 'low' && <Check className="w-3 h-3" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSelectQuality('medium')}
                      className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center justify-between cursor-pointer ${
                        selectedQuality === 'medium'
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'text-zinc-300 hover:bg-zinc-800'
                      }`}
                    >
                      <span>480p (Balanced)</span>
                      {selectedQuality === 'medium' && <Check className="w-3 h-3" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSelectQuality('high')}
                      className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center justify-between cursor-pointer ${
                        selectedQuality === 'high'
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'text-zinc-300 hover:bg-zinc-800'
                      }`}
                    >
                      <span>720p (High Quality)</span>
                      {selectedQuality === 'high' && <Check className="w-3 h-3" />}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Leave Stream Control (When connected to LiveKit) */}
            {(playerState === 'playing' ||
              playerState === 'waiting_host' ||
              playerState === 'reconnecting') && (
              <button
                type="button"
                onClick={leaveLiveStream}
                className="px-2 py-1 rounded-lg bg-rose-600/80 hover:bg-rose-600 text-white border border-rose-500 text-[11px] font-bold transition-all cursor-pointer flex items-center gap-1"
                title="Disconnect from live stream"
              >
                <LogOut className="w-3 h-3" />
                <span className="hidden sm:inline">Leave</span>
              </button>
            )}

            {/* Host Broadcast Drawer Toggle */}
            {isHost && (
              <button
                type="button"
                onClick={() => setShowHostSettings((prev) => !prev)}
                className={`p-1.5 rounded-lg border text-xs font-bold transition-all cursor-pointer flex items-center gap-1 ${
                  showHostSettings
                    ? 'bg-emerald-500 text-zinc-950 border-emerald-400'
                    : 'bg-black/60 backdrop-blur-md border-white/10 text-zinc-300 hover:text-white hover:bg-zinc-800'
                }`}
                title="Host Broadcast Ingestion Settings"
              >
                <Settings className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Ingest</span>
              </button>
            )}

            {/* Mute/Unmute */}
            <button
              type="button"
              onClick={handleToggleMute}
              className="p-1.5 rounded-lg bg-black/60 backdrop-blur-md border border-white/10 hover:bg-zinc-800 text-zinc-300 hover:text-white transition-all cursor-pointer"
              title={isMuted ? 'Unmute Stream' : 'Mute Stream'}
              aria-label="Toggle mute"
            >
              {isMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
            </button>

            {/* Fullscreen */}
            <button
              type="button"
              onClick={toggleFullscreen}
              className="p-1.5 rounded-lg bg-black/60 backdrop-blur-md border border-white/10 hover:bg-zinc-800 text-zinc-300 hover:text-white transition-all cursor-pointer"
              title="Toggle Fullscreen"
              aria-label="Toggle fullscreen"
            >
              {isFullscreen ? (
                <Minimize2 className="w-3.5 h-3.5" />
              ) : (
                <Maximize2 className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>

        {/* 3. Bottom Player Bar Overlay */}
        <div className="absolute bottom-0 inset-x-0 p-3 bg-gradient-to-t from-black/85 via-black/40 to-transparent flex items-center justify-between pointer-events-none z-20">
          <div className="text-[11px] text-zinc-300 font-bold flex items-center gap-2">
            <span className="text-white drop-shadow">{room.title}</span>
            <span className="text-zinc-500">•</span>
            <span className="text-zinc-400 font-normal">Host: {room.hostName}</span>
          </div>

          <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-400">
            <span className="px-1.5 py-0.5 rounded bg-black/50 border border-white/10">
              {isLiveStreamActive ? 'LiveKit WebRTC' : 'WebRTC/HLS Ready'}
            </span>
            <span className="hidden sm:inline px-1.5 py-0.5 rounded bg-emerald-950/60 border border-emerald-800/40 text-emerald-300">
              Low Latency
            </span>
          </div>
        </div>
      </div>

      {/* 4. Host Broadcast Ingest Drawer (Host only) */}
      {isHost && showHostSettings && (
        <div className="p-3 bg-[#0B0E17] border-t border-white/[0.08] space-y-2 z-30 animate-in slide-in-from-top-2 duration-150 shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-black text-white">
              <Radio className="w-3.5 h-3.5 text-emerald-400" />
              <span>Host Stream Ingestion Controls</span>
            </div>
            <button
              type="button"
              onClick={() => setShowHostSettings(false)}
              className="text-[10px] text-zinc-400 hover:text-white underline cursor-pointer"
            >
              Dismiss
            </button>
          </div>

          {broadcastError && (
            <div className="px-2.5 py-1.5 rounded-lg bg-rose-950/80 border border-rose-800 text-rose-300 text-[11px] flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span>{broadcastError}</span>
            </div>
          )}

          {broadcastSuccess && (
            <div className="px-2.5 py-1.5 rounded-lg bg-emerald-950/80 border border-emerald-800 text-emerald-300 text-[11px] flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 shrink-0" />
              <span>{broadcastSuccess}</span>
            </div>
          )}

          {/* A. Native Android MediaProjection Gameplay Broadcaster */}
          <div className="p-2.5 rounded-xl bg-zinc-900/90 border border-emerald-500/20 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-white">
                <Smartphone className="w-3.5 h-3.5 text-emerald-400" />
                <span>Native Android Gameplay Broadcast (MediaProjection)</span>
              </div>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800/40">
                LiveKit WebRTC
              </span>
            </div>

            {androidBroadcastError && (
              <div className="px-2.5 py-1.5 rounded-lg bg-rose-950/80 border border-rose-800 text-rose-300 text-[11px] flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{androidBroadcastError}</span>
              </div>
            )}

            {androidBroadcastSuccess && (
              <div className="px-2.5 py-1.5 rounded-lg bg-emerald-950/80 border border-emerald-800 text-emerald-300 text-[11px] flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 shrink-0" />
                <span>{androidBroadcastSuccess}</span>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-zinc-400 shrink-0">Quality:</label>
                <select
                  value={androidQuality}
                  onChange={(e) => setAndroidQuality(e.target.value as any)}
                  className="bg-black/60 border border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500 font-mono w-full"
                >
                  <option value="auto">Auto (Adaptive ~1.8 Mbps)</option>
                  <option value="360p">360p Data Saver (700 kbps)</option>
                  <option value="480p">480p Balanced (1.5 Mbps)</option>
                  <option value="720p">720p HD Game (2.5 Mbps)</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="chkInternalAudio"
                  checked={captureInternalAudio}
                  onChange={(e) => setCaptureInternalAudio(e.target.checked)}
                  className="rounded border-white/10 text-emerald-500 focus:ring-emerald-500 bg-zinc-800"
                />
                <label htmlFor="chkInternalAudio" className="text-[11px] text-zinc-300 flex items-center gap-1 cursor-pointer">
                  <Mic className="w-3 h-3 text-emerald-400" />
                  <span>Internal Game Audio (Android 10+)</span>
                </label>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              {isAndroidBroadcasting || room.stream?.isLive ? (
                <button
                  type="button"
                  onClick={handleStopAndroidBroadcast}
                  disabled={isStartingAndroidBroadcast}
                  className="px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs flex items-center gap-1 transition-all cursor-pointer disabled:opacity-50"
                >
                  {isStartingAndroidBroadcast ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Square className="w-3.5 h-3.5" />
                  )}
                  <span>Stop Android Broadcast</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleStartAndroidBroadcast}
                  disabled={isStartingAndroidBroadcast}
                  className="px-3.5 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black text-xs flex items-center gap-1.5 transition-all cursor-pointer shadow-md shadow-emerald-500/20 active:scale-95 disabled:opacity-50"
                >
                  {isStartingAndroidBroadcast ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Smartphone className="w-3.5 h-3.5" />
                  )}
                  <span>Broadcast Android Gameplay</span>
                </button>
              )}

              <span className="text-[10px] text-zinc-400 font-mono">
                {nativeBroadcaster.isNativeAndroid()
                  ? 'Native Android App Active'
                  : 'Web Browser Sandbox Mode'}
              </span>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="url"
              placeholder="Stream Ingest URL (https://... or .m3u8 / WebRTC)..."
              value={streamUrlInput}
              onChange={(e) => setStreamUrlInput(e.target.value)}
              className="flex-1 bg-zinc-900 border border-white/10 rounded-xl px-3 py-1.5 text-xs text-white placeholder:text-zinc-500 focus:outline-none focus:border-emerald-500 font-mono"
            />

            <select
              value={streamProtocol}
              onChange={(e) => setStreamProtocol(e.target.value as any)}
              className="bg-zinc-900 border border-white/10 rounded-xl px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500 font-mono"
            >
              <option value="hls">HLS Protocol</option>
              <option value="webrtc">WebRTC Direct</option>
              <option value="custom">Custom Ingest</option>
            </select>

            <div className="flex items-center gap-2">
              {room.stream?.isLive ? (
                <button
                  type="button"
                  onClick={() => handleUpdateBroadcast(false)}
                  disabled={isUpdatingBroadcast}
                  className="px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs flex items-center gap-1 transition-all cursor-pointer disabled:opacity-50"
                >
                  {isUpdatingBroadcast ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Square className="w-3.5 h-3.5" />
                  )}
                  <span>Stop Broadcast</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handleUpdateBroadcast(true)}
                  disabled={isUpdatingBroadcast || !streamUrlInput.trim()}
                  className="px-3 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black text-xs flex items-center gap-1 transition-all cursor-pointer disabled:opacity-40"
                >
                  {isUpdatingBroadcast ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Play className="w-3.5 h-3.5 fill-current" />
                  )}
                  <span>Go Live</span>
                </button>
              )}

              <button
                type="button"
                onClick={handleUseSampleStream}
                disabled={isUpdatingBroadcast}
                className="px-2.5 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-white/10 font-bold text-[11px] transition-all cursor-pointer whitespace-nowrap"
                title="Populate and stream test video"
              >
                Test Stream
              </button>
            </div>
          </div>

          <div className="text-[10px] text-zinc-400 flex items-center gap-1 font-mono">
            <Info className="w-3 h-3 text-emerald-400 shrink-0" />
            <span>
              LiveKit & WebRTC enabled: Viewers connect via LiveKit WebRTC tokens or direct HLS endpoints.
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
