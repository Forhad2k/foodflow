'use client';
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, CheckCheck, Flag, Lock, Send } from 'lucide-react';
import { toast } from 'sonner';
import { realtime } from '@/lib/socket';
import { api, ApiError } from '@/lib/api';
import { Button } from './ui/button';
import { Input, Label } from './ui/form';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import type { ChatMessage } from '@/lib/types';
import { formatDateTime } from '@/lib/format';

interface OrderChatProps {
  orderId: string;
  orderNumber?: string;
  currentUserRole: 'CUSTOMER' | 'RIDER';
}

function ReportDialog({
  open,
  onOpenChange,
  orderId,
  messageId,
  currentUserRole,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: string;
  messageId: string;
  currentUserRole: 'CUSTOMER' | 'RIDER';
}) {
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);

  const report = async () => {
    if (!reason.trim()) return;
    setLoading(true);
    try {
      const endpoint =
        currentUserRole === 'RIDER'
          ? `/rider/deliveries/${orderId}/chat/messages/${messageId}/report`
          : `/orders/${orderId}/chat/messages/${messageId}/report`;
      await api.post(endpoint, { reason: reason.trim() });
      toast.success('Message reported to moderators');
      onOpenChange(false);
      setReason('');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ALREADY_REPORTED') {
        toast.info('You have already reported this message.');
        onOpenChange(false);
      } else {
        toast.error(e instanceof ApiError ? e.message : 'Could not report message');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Report inappropriate message</DialogTitle>
        <DialogDescription>
          Help us keep FoodFlow safe. Moderators will review this message.
        </DialogDescription>
        <div className="mt-4 space-y-3">
          <Label htmlFor="rep-reason">Why are you reporting this message?</Label>
          <Input
            id="rep-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Harassment, inappropriate language, spam"
            maxLength={200}
          />
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="destructive" onClick={report} loading={loading} disabled={!reason.trim()}>
              Submit report
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function OrderChat({ orderId, orderNumber, currentUserRole }: OrderChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isOpen, setIsOpen] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [reportingId, setReportingId] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement | null>(null);

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    let mounted = true;

    // Join room
    realtime.joinChat(orderId).then((res) => {
      if (!mounted) return;
      if (res.ok && res.messages) {
        setMessages(res.messages);
        if (res.room) setIsOpen(res.room.open);
        setTimeout(scrollToBottom, 100);
        // Mark read
        void realtime.readChat(orderId);
      } else if (res.error?.code === 'CHAT_NOT_AVAILABLE') {
        setIsOpen(false);
      }
    });

    const unMsg = realtime.onChatMessage((msg) => {
      if (!mounted || msg.orderId !== orderId) return;
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id || (m.clientMessageId && m.clientMessageId === msg.clientMessageId))) {
          return prev;
        }
        return [...prev, msg];
      });
      setTimeout(scrollToBottom, 100);

      // If from other party, mark read
      if (msg.senderRole !== currentUserRole) {
        void realtime.readChat(orderId, msg.id);
      }
    });

    const unDeliv = realtime.onChatDelivered((d) => {
      if (!mounted) return;
      setMessages((prev) =>
        prev.map((m) => (m.id === d.messageId ? { ...m, deliveredAt: d.deliveredAt } : m)),
      );
    });

    const unRead = realtime.onChatRead((r) => {
      if (!mounted) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.senderRole === currentUserRole && (!m.readAt || (r.upToMessageId && m.id <= r.upToMessageId))
            ? { ...m, readAt: r.readAt, deliveredAt: m.deliveredAt ?? r.readAt }
            : m,
        ),
      );
    });

    return () => {
      mounted = false;
      realtime.leaveChat(orderId);
      unMsg();
      unDeliv();
      unRead();
    };
  }, [orderId, currentUserRole]);

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || sending || !isOpen) return;
    const body = text.trim();
    setText('');
    setSending(true);

    const clientMsgId = `cmsg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const tempMsg: ChatMessage = {
      id: clientMsgId,
      orderId,
      senderId: 'me',
      senderRole: currentUserRole,
      body,
      clientMessageId: clientMsgId,
      createdAt: new Date().toISOString(),
      deliveredAt: null,
      readAt: null,
    };
    setMessages((prev) => [...prev, tempMsg]);
    setTimeout(scrollToBottom, 50);

    const res = await realtime.sendChatMessage(orderId, body, clientMsgId);
    setSending(false);
    if (res.ok && res.message) {
      setMessages((prev) =>
        prev.map((m) => (m.clientMessageId === clientMsgId ? res.message! : m)),
      );
    } else if (res.error) {
      toast.error(res.error.message ?? 'Could not send message');
      setMessages((prev) => prev.filter((m) => m.clientMessageId !== clientMsgId));
    }
  };

  return (
    <div className="flex flex-col rounded-card border border-border bg-card overflow-hidden h-[420px]">
      {/* Chat Header */}
      <div className="flex items-center justify-between border-b border-border bg-panel px-4 py-3">
        <div>
          <h3 className="font-bold text-sm">
            Delivery Chat {orderNumber ? `· #${orderNumber}` : ''}
          </h3>
          <p className="text-xs text-muted-foreground">
            Direct chat between customer and assigned rider
          </p>
        </div>
        {!isOpen && (
          <span className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
            <Lock className="h-3 w-3" /> Closed
          </span>
        )}
      </div>

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
            <p>No messages yet.</p>
            <p className="text-xs mt-1">Coordination regarding delivery directions or address notes.</p>
          </div>
        ) : (
          messages.map((m) => {
            const isMe = m.senderRole === currentUserRole;
            return (
              <div
                key={m.id}
                className={`flex flex-col ${isMe ? 'items-end' : 'items-start'} group`}
              >
                <div
                  className={`relative max-w-[80%] rounded-tile px-3.5 py-2 text-sm ${
                    isMe
                      ? 'bg-primary text-primary-foreground font-medium'
                      : 'bg-panel text-foreground border border-border'
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>

                  <div className={`flex items-center justify-end gap-1 text-[10px] mt-1 ${isMe ? 'text-primary-foreground/75' : 'text-muted-foreground'}`}>
                    <span>{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>

                    {isMe && (
                      <span title={m.readAt ? 'Read' : m.deliveredAt ? 'Delivered' : 'Sent'}>
                        {m.readAt ? (
                          <CheckCheck className="h-3 w-3 text-ink" />
                        ) : m.deliveredAt ? (
                          <CheckCheck className="h-3 w-3 opacity-60" />
                        ) : (
                          <Check className="h-3 w-3 opacity-60" />
                        )}
                      </span>
                    )}
                  </div>
                </div>

                {!isMe && (
                  <button
                    type="button"
                    onClick={() => setReportingId(m.id)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-[11px] text-muted-foreground hover:text-destructive flex items-center gap-1 mt-0.5 px-1"
                  >
                    <Flag className="h-2.5 w-2.5" /> Report
                  </button>
                )}
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Chat Input or Closed Message */}
      {isOpen ? (
        <form onSubmit={sendMessage} className="flex gap-2 border-t border-border p-3 bg-background">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a message to the rider…"
            maxLength={500}
            className="flex-1 text-sm h-10"
          />
          <Button type="submit" size="sm" disabled={!text.trim() || sending} className="h-10 px-4">
            <Send className="h-4 w-4" />
          </Button>
        </form>
      ) : (
        <div className="border-t border-border bg-panel p-3 text-center text-xs text-muted-foreground">
          This chat has concluded and is now read-only.
        </div>
      )}

      {reportingId && (
        <ReportDialog
          open={!!reportingId}
          onOpenChange={(o) => !o && setReportingId(null)}
          orderId={orderId}
          messageId={reportingId}
          currentUserRole={currentUserRole}
        />
      )}
    </div>
  );
}

