'use strict';

import * as vscode from 'vscode';
import { Configuration, OpenAIApi } from "openai";

let openai: OpenAIApi | undefined = undefined;

let commentId = 1;

class NoteComment implements vscode.Comment {
	id: number;
	label: string | undefined;
	savedBody: string | vscode.MarkdownString; // for the Cancel button
	constructor(
		public body: string | vscode.MarkdownString,
		public mode: vscode.CommentMode,
		public author: vscode.CommentAuthorInformation,
		public parent?: vscode.CommentThread,
		public contextValue?: string
	) {
		this.id = ++commentId;
		this.savedBody = this.body;
	}
}

/**
 * Shows an input box for getting API key using window.showInputBox().
 * Checks if inputted API Key is valid.
 * Updates the User Settings API Key with the newly inputted API Key.
 */
export async function showInputBox() {
	const result = await vscode.window.showInputBox({
		ignoreFocusOut: true,
		placeHolder: 'Your OpenAI API Key',
		title: 'Scribe AI',
		prompt: 'You have not set your OpenAI API key yet or your API key is incorrect, please enter your API key to use the ScribeAI extension.',
		validateInput: async text => {
			vscode.window.showInformationMessage(`Validating: ${text}`);
			if (text === '') {
				return 'The API Key can not be empty';
			}
			try {
				openai = new OpenAIApi(new Configuration({
					apiKey: text,
				}));
				await openai.listModels();
			} catch(err) {
				return 'Your API key is invalid';
			}
			return null;
		}
	});
	vscode.window.showInformationMessage(`Got: ${result}`);
	// Write to user settings
	await vscode.workspace.getConfiguration('scribeai').update('ApiKey', result, true);
	// Write to workspace settings
	//await vscode.workspace.getConfiguration('scribeai').update('ApiKey', result, false);
	return result;
}

async function validateAPIKey() {
	try {
		openai = new OpenAIApi(new Configuration({
			apiKey: vscode.workspace.getConfiguration('scribeai').get('ApiKey'),
		}));
		await openai.listModels();
	} catch(err) {
		return false;
	}
	return true;
}

export async function activate(context: vscode.ExtensionContext) {
	// Workspace settings override User settings when getting the setting.
	if (vscode.workspace.getConfiguration('scribeai').get('ApiKey') === "" 
		|| !(await validateAPIKey())) {
		const apiKey = await showInputBox();
	}
	if (openai === undefined) {
		openai = new OpenAIApi(new Configuration({
			apiKey: vscode.workspace.getConfiguration('scribeai').get('ApiKey'),
		}));
	}

	// A `CommentController` is able to provide comments for documents.
	const commentController = vscode.comments.createCommentController('comment-scribeai', 'ScribeAI Comment Controller');
	context.subscriptions.push(commentController);

	// A `CommentingRangeProvider` controls where gutter decorations that allow adding comments are shown
	commentController.commentingRangeProvider = {
		provideCommentingRanges: (document: vscode.TextDocument, token: vscode.CancellationToken) => {
			const lineCount = document.lineCount;
			return [new vscode.Range(0, 0, lineCount - 1, 0)];
		}
	};

	commentController.options = {
		prompt: "Ask Scribe AI...",
		placeHolder: "Ask me anything! Example: \"Explain the above code in plain English\""
	};

	context.subscriptions.push(vscode.commands.registerCommand('mywiki.createNote', (reply: vscode.CommentReply) => {
		replyNote(reply);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('mywiki.askAI', (reply: vscode.CommentReply) => {
		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Generating AI response...",
			cancellable: true
		}, async () => {
			await askAI(reply);		
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('mywiki.aiEdit', (reply: vscode.CommentReply) => {
		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Generating AI response...",
			cancellable: true
		}, async () => {
			await aiEdit(reply);		
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('mywiki.genDocString', (reply: vscode.CommentReply) => {
		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Generating AI response...",
			cancellable: true
		}, async () => {
			reply.text = "Write an elaborate, high quality docstring for the above function";
			await askAI(reply);		
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('mywiki.replyNote', (reply: vscode.CommentReply) => {
		replyNote(reply);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('mywiki.deleteNoteComment', (comment: NoteComment) => {
		const thread = comment.parent;
		if (!thread) {
			return;
		}

		thread.comments = thread.comments.filter(cmt => (cmt as NoteComment).id !== comment.id);

		if (thread.comments.length === 0) {
			thread.dispose();
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('mywiki.deleteNote', (thread: vscode.CommentThread) => {
		thread.dispose();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('mywiki.cancelsaveNote', (comment: NoteComment) => {
		if (!comment.parent) {
			return;
		}

		comment.parent.comments = comment.parent.comments.map(cmt => {
			if ((cmt as NoteComment).id === comment.id) {
				cmt.body = (cmt as NoteComment).savedBody;
				cmt.mode = vscode.CommentMode.Preview;
			}

			return cmt;
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('mywiki.saveNote', (comment: NoteComment) => {
		if (!comment.parent) {
			return;
		}

		comment.parent.comments = comment.parent.comments.map(cmt => {
			if ((cmt as NoteComment).id === comment.id) {
				(cmt as NoteComment).savedBody = cmt.body;
				cmt.mode = vscode.CommentMode.Preview;
			}

			return cmt;
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('mywiki.editNote', (comment: NoteComment) => {
		if (!comment.parent) {
			return;
		}

		comment.parent.comments = comment.parent.comments.map(cmt => {
			if ((cmt as NoteComment).id === comment.id) {
				cmt.mode = vscode.CommentMode.Editing;
			}

			return cmt;
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('mywiki.dispose', () => {
		commentController.dispose();
	}));

	/**
	 * Generates the prompt to pass to OpenAI.
	 * Prompt includes: 
	 * - Role play text that gives context to AI
	 * - Code block highlighted for the comment thread
	 * - All of past conversation history + example conversation
	 * - User's new question
	 * @param question
	 * @param thread 
	 * @returns 
	 */
	function generatePromptV1(question: string, thread: vscode.CommentThread) {
		const rolePlay =
			"I want you to act as a highly intelligent AI chatbot that has deep understanding of any coding language and its API documentations. I will provide you with a code block and your role is to provide a comprehensive answer to any questions or requests that I will ask about the code block. Please answer in as much detail as possible and not be limited to brevity. It is very important that you provide verbose answers.";
		//const codeBlock = "class Log:\n    def __init__(self, path):\n        dirname = os.path.dirname(path)\n        os.makedirs(dirname, exist_ok=True)\n        f = open(path, \"a+\")\n\n        # Check that the file is newline-terminated\n        size = os.path.getsize(path)\n        if size > 0:\n            f.seek(size - 1)\n            end = f.read(1)\n            if end != \"\\n\":\n                f.write(\"\\n\")\n        self.f = f\n        self.path = path\n\n    def log(self, event):\n        event[\"_event_id\"] = str(uuid.uuid4())\n        json.dump(event, self.f)\n        self.f.write(\"\\n\")\n\n    def state(self):\n        state = {\"complete\": set(), \"last\": None}\n        for line in open(self.path):\n            event = json.loads(line)\n            if event[\"type\"] == \"submit\" and event[\"success\"]:\n                state[\"complete\"].add(event[\"id\"])\n                state[\"last\"] = event\n        return state";
		const codeBlock = getCommentThreadCode(thread);
		
		let conversation = "Human: Who are you?\n\nAI: I am a intelligent AI chatbot\n\n";
		
		for (let i = 0; i < thread.comments.length; i++) {
			if (thread.comments[i].label !== "NOTE") {
				if (thread.comments[i].author.name === "VS Code") {
					conversation += `Human: ${thread.comments[i].body}\n\n`;
				} else if (thread.comments[i].author.name === "Scribe AI") {
					conversation += `AI: ${thread.comments[i].body}\n\n`;
				}
			}
		}
		conversation += `Human: ${question}\n\nAI: `;

		return rolePlay + "\n" + codeBlock + "\n\n\n" + conversation; 
	}

	/**
	 * Generates the prompt to pass to OpenAI.
	 * Note: Not as performant as V1 but consumes less tokens per request.
	 * Prompt includes: 
	 * - Role play text that gives context to AI
	 * - Code block highlighted for the comment thread
	 * - An example conversation to give the AI an example. "Human: Who are you?\nAI: I am a intelligent AI chatbot\n";
	 * - User's new question
	 * @param question
	 * @param thread 
	 * @returns 
	 */
	function generatePromptV2(question: string, thread: vscode.CommentThread) {
		const rolePlay =
			"I want you to act as a highly intelligent AI chatbot that has deep understanding of any coding language and its API documentations. I will provide you with a code block and your role is to provide a comprehensive answer to any questions or requests that I will ask about the code block. Please answer in as much detail as possible and not be limited to brevity. It is very important that you provide verbose answers.";
		//const codeBlock = "class Log:\n    def __init__(self, path):\n        dirname = os.path.dirname(path)\n        os.makedirs(dirname, exist_ok=True)\n        f = open(path, \"a+\")\n\n        # Check that the file is newline-terminated\n        size = os.path.getsize(path)\n        if size > 0:\n            f.seek(size - 1)\n            end = f.read(1)\n            if end != \"\\n\":\n                f.write(\"\\n\")\n        self.f = f\n        self.path = path\n\n    def log(self, event):\n        event[\"_event_id\"] = str(uuid.uuid4())\n        json.dump(event, self.f)\n        self.f.write(\"\\n\")\n\n    def state(self):\n        state = {\"complete\": set(), \"last\": None}\n        for line in open(self.path):\n            event = json.loads(line)\n            if event[\"type\"] == \"submit\" and event[\"success\"]:\n                state[\"complete\"].add(event[\"id\"])\n                state[\"last\"] = event\n        return state";
		const codeBlock = getCommentThreadCode(thread);
		
		let conversation = "Human: Who are you?\n\nAI: I am a intelligent AI chatbot\n\n";
		conversation += `Human: ${question}\n\nAI: `;
		return rolePlay + "\n" + codeBlock + "\n\n\n" + conversation; 
	}

	/**
	 * Gets the highlighted code for this comment thread
	 * @param thread
	 * @returns 
	 */
	function getCommentThreadCode(thread: vscode.CommentThread) {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return; // No open text editor
		}
		const document = editor.document;
		// Get selected code for the comment thread
		return document.getText(thread.range);
	}

	/**
	 * User replies with a question.
	 * The question + conversation history + code block then gets used
	 * as input to call the OpenAI API to get a response.
	 * The new humna question and AI response then gets added to the thread.
	 * @param reply 
	 */
	async function askAI(reply: vscode.CommentReply) {
		const question = reply.text.trim();
		const code = getCommentThreadCode(reply.thread);
		const thread = reply.thread;
		const prompt = generatePromptV1(question, thread);
		const model = vscode.workspace.getConfiguration('scribeai').get('models') + "";
		const humanComment = new NoteComment(question, vscode.CommentMode.Preview, { name: 'VS Code', iconPath: vscode.Uri.parse("https://img.icons8.com/fluency/96/null/user-male-circle.png") }, thread, thread.comments.length ? 'canDelete' : undefined);
		thread.comments = [...thread.comments, humanComment];
		
		// If openai is not initialized initialize it with existing API Key 
		// or if doesn't exist then ask user to input API Key.
		if (openai === undefined) {
			if (vscode.workspace.getConfiguration('scribeai').get('ApiKey') === '') {
				const apiKey = await showInputBox();
			}
		
			openai = new OpenAIApi(new Configuration({
				apiKey: vscode.workspace.getConfiguration('scribeai').get('ApiKey'),
			}));
		}
		
		const response = await openai.createCompletion({
			model: model === "ChatGPT" ? "text-chat-davinci-002-20230126" : model,
			prompt: prompt,
			//prompt: generatePromptV2(question, thread),
			temperature: 0,
			max_tokens: 1000,
			top_p: 1.0,
			frequency_penalty: 1,
			presence_penalty: 1,
			stop: ["Human:"],  // V1: "Human:"
		});

		const responseText = response.data.choices[0].text ? response.data.choices[0].text : 'An error occured. Please try again...';
		const AIComment = new NoteComment(responseText.trim().replace("<|im_end|>", ""), vscode.CommentMode.Preview, { name: 'Scribe AI', iconPath: vscode.Uri.parse("https://img.icons8.com/fluency/96/null/chatbot.png") }, thread, thread.comments.length ? 'canDelete' : undefined);
		thread.comments = [...thread.comments, AIComment];
	}

	/**
	 * AI will edit the highlighted code based on the given instructions.
	 * Uses the OpenAI Edits endpoint. Replaces the highlighted code
	 * with AI generated code. You can undo to go back.
	 * 
	 * @param reply 
	 * @returns 
	 */
	async function aiEdit(reply: vscode.CommentReply) {
		const question = reply.text.trim();
		const code = getCommentThreadCode(reply.thread);
		const thread = reply.thread;

		// If openai is not initialized initialize it with existing API Key 
		// or if doesn't exist then ask user to input API Key.
		if (openai === undefined) {
			if (vscode.workspace.getConfiguration('scribeai').get('ApiKey') === '') {
				const apiKey = await showInputBox();
			}
		
			openai = new OpenAIApi(new Configuration({
				apiKey: vscode.workspace.getConfiguration('scribeai').get('ApiKey'),
			}));
		}

		const response = await openai.createEdit({
			model: "code-davinci-edit-001",
			input: code,
			instruction: question,
			temperature: 0,
			top_p: 1.0,
		});
		if (response.data.choices[0].text) {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				return; // No open text editor
			}
			const document = editor.document;
			editor.edit(editBuilder => {
				editBuilder.replace(thread.range, response.data.choices[0].text + "");
			});
		} else {
			vscode.window.showErrorMessage('An error occured. Please try again...');
		}
	}

	/**
	 * Adds a regular note. Doesn't call OpenAI API.
	 * @param reply 
	 */
	function replyNote(reply: vscode.CommentReply) {
		const thread = reply.thread;
		const newComment = new NoteComment(reply.text, vscode.CommentMode.Preview, { name: 'VS Code', iconPath: vscode.Uri.parse("https://img.icons8.com/fluency/96/null/user-male-circle.png") }, thread, thread.comments.length ? 'canDelete' : undefined);
		newComment.label = 'NOTE';
		thread.comments = [...thread.comments, newComment];
	}
}
