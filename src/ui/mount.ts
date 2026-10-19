import {createElement} from 'react';
import {ChatView, type ChatViewProps} from './ChatView.js';
import {SessionPicker, type SessionPickerProps} from './SessionPicker.js';

export type {ChatViewProps, SessionPickerProps};

export function createChatElement(props: ChatViewProps): object {
	return createElement(ChatView, props);
}

export function createPickerElement(props: SessionPickerProps): object {
	return createElement(SessionPicker, props);
}
