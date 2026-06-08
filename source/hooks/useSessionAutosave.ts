import {useEffect, useRef} from 'react';
import {getAppConfig} from '@/config/index';
import {sessionManager} from '@/session/session-manager';
import type {Message} from '@/types/core';
import {formatError} from '@/utils/error-formatter';
import {logWarning} from '@/utils/message-queue';

interface UseSessionAutosaveProps {
	messages: Message[];
	currentProvider: string;
	currentModel: string;
	currentSessionId: string | null;
	setCurrentSessionId: (id: string | null) => void;
}

/**
 * Hook to handle automatic session saving.
 * Updates the current session when currentSessionId is set; otherwise creates a new session.
 * Clears currentSessionId when messages are cleared.
 *
 * Race-safety: all saves are serialized through saveChainRef so only one
 * createSession() can run at a time. currentSessionIdRef always reflects the
 * latest React state value so async callbacks never act on a stale closure ID.
 *
 * Persistence: the full message array is always written to disk. maxMessages
 * only governs what is sent to the model (context window), not what is stored.
 */
export function useSessionAutosave({
	messages,
	currentProvider,
	currentModel,
	currentSessionId,
	setCurrentSessionId,
}: UseSessionAutosaveProps) {
	const initPromiseRef = useRef<Promise<boolean> | null>(null);
	const timeoutRef = useRef<NodeJS.Timeout | null>(null);
	const lastSaveRef = useRef<number>(0);

	const currentSessionIdRef = useRef<string | null>(currentSessionId);
	useEffect(() => {
		currentSessionIdRef.current = currentSessionId;
	}, [currentSessionId]);

	const saveChainRef = useRef<Promise<void>>(Promise.resolve());

	// Clear current session when conversation is cleared
	useEffect(() => {
		if (messages.length === 0 && currentSessionId !== null) {
			setCurrentSessionId(null);
		}
	}, [messages.length, currentSessionId, setCurrentSessionId]);

	// Initialize session manager only when autosave is enabled (avoids creating
	// sessions dir/index and running retention when user has autosave off).
	// /resume initializes the manager when the user explicitly runs it.
	useEffect(() => {
		const config = getAppConfig();
		const autoSave = config.sessions?.autoSave ?? true;
		if (!autoSave) {
			return;
		}

		if (!initPromiseRef.current) {
			initPromiseRef.current = sessionManager
				.initialize()
				.then(() => true)
				.catch(error => {
					logWarning(
						`Session autosave disabled: failed to initialize session storage. ${formatError(error)}`,
					);
					return false;
				});
		}

		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}
		};
	}, []);

	// Auto-save when messages change (debounced by saveInterval)
	useEffect(() => {
		const config = getAppConfig();
		const sessionConfig = config.sessions;
		const autoSave = sessionConfig?.autoSave ?? true;
		const saveInterval = sessionConfig?.saveInterval ?? 30000;

		if (!autoSave || !initPromiseRef.current || messages.length === 0) {
			return;
		}

		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
		}

		const now = Date.now();
		const timeSinceLastSave = now - lastSaveRef.current;

		const messagesToPersist = messages;
		const providerAtSchedule = currentProvider;
		const modelAtSchedule = currentModel;

		const doSave = async () => {
			try {
				// Wait for initialization to complete before saving
				const initialized = await initPromiseRef.current;
				if (!initialized) return;

				// Derive the session title from the full history.
				const userMessages = messagesToPersist.filter(
					msg => msg.role === 'user',
				);
				const lastUserMessage = userMessages[userMessages.length - 1];
				const title = lastUserMessage
					? lastUserMessage.content.substring(0, 50) +
						(lastUserMessage.content.length > 50 ? '...' : '')
					: `Session ${new Date().toLocaleDateString()}`;

				const sessionId = currentSessionIdRef.current;

				if (sessionId) {
					const session = await sessionManager.readSession(sessionId);
					if (session) {
						session.messages = messagesToPersist;
						session.messageCount = messagesToPersist.length;
						session.title = title;
						session.provider = providerAtSchedule;
						session.model = modelAtSchedule;
						// Don't set lastAccessedAt here — saveSession() handles
						// the timestamp in both the file and index consistently.
						await sessionManager.saveSession(session);
					} else {
						const newSession = await sessionManager.createSession({
							title,
							messageCount: messagesToPersist.length,
							provider: providerAtSchedule,
							model: modelAtSchedule,
							workingDirectory: process.cwd(),
							messages: messagesToPersist,
						});
						setCurrentSessionId(newSession.id);
						currentSessionIdRef.current = newSession.id;
					}
				} else {
					const latestId = currentSessionIdRef.current;
					if (latestId) {
						const session = await sessionManager.readSession(latestId);
						if (session) {
							session.messages = messagesToPersist;
							session.messageCount = messagesToPersist.length;
							session.title = title;
							session.provider = providerAtSchedule;
							session.model = modelAtSchedule;
							await sessionManager.saveSession(session);
						}
					} else {
						const newSession = await sessionManager.createSession({
							title,
							messageCount: messagesToPersist.length,
							provider: providerAtSchedule,
							model: modelAtSchedule,
							workingDirectory: process.cwd(),
							messages: messagesToPersist,
						});
						setCurrentSessionId(newSession.id);
						currentSessionIdRef.current = newSession.id;
					}
				}

				lastSaveRef.current = Date.now();
			} catch (error) {
				console.warn('Failed to auto-save session:', error);
			}
		};

		if (timeSinceLastSave >= saveInterval) {
			saveChainRef.current = saveChainRef.current.then(doSave);
		} else {
			const delay = saveInterval - timeSinceLastSave;
			timeoutRef.current = setTimeout(() => {
				saveChainRef.current = saveChainRef.current.then(doSave);
			}, delay);
		}
	}, [messages, currentProvider, currentModel, setCurrentSessionId]);
}
