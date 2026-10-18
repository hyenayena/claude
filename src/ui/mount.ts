import {createElement} from 'react';
import {ChatView, type ChatViewProps} from './ChatView.js';

export type {ChatViewProps};

export function createChatElement(props: ChatViewProps): object {
	return createElement(ChatView, props);
}
