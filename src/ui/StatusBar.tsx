import React from 'react';
import {Text} from 'ink';

export function StatusBar({text}: {text: string}) {
	return (
		<Text dimColor wrap="truncate">
			{text}
		</Text>
	);
}
