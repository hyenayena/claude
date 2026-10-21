import {createElement} from 'react';
import {ChatView, type ChatViewProps} from './ChatView.js';
import {ListPicker, type ListPickerProps} from './kit.js';

export type {ChatViewProps, ListPickerProps};

export function createChatElement(props: ChatViewProps): object {
	return createElement(ChatView, props);
}

export function createPickerElement(props: ListPickerProps): object {
	return createElement(ListPicker, props);
}
