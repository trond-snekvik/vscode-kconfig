const vscode = acquireVsCodeApi();

// help
// const title = document.getElementsByName("title");
// title.forEach(el => {
// 	el.addEventListener("mouseenter", () => {
// 		vscode.postMessage({
// 			cmd: "help",
// 			key: el.id
// 		});
// 	});
// 	el.addEventListener("mouseleave", () => {
// 		vscode.postMessage({
// 			cmd: "help",
// 			key: ''
// 		});
// 	});
// });

// var help = document.getElementById('help');
// window.onmousemove = function(e) {
// 	var x = e.clientX;
// 	var y = e.clientY;
// 	help.style.left = (x + 20) + 'px';
// 	help.style.top = (y + 20) + 'px';
// };

document.addEventListener('keydown', e => {
	if (document.activeElement.tagName === 'input') {
		return;
	}

	const setActive = function(elem) {
		if (elem.focus) {
			elem.focus();
		}
	}

	if (e.key === 'ArrowLeft') {
		e.preventDefault();
		const up = document.getElementById('up');
		if (up && up.onclick) {
			up.click();
		}
		return;
	}

	if (!document.activeElement.className.split(' ').includes('row')) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			setActive(document.getElementById('menuconfig-content').firstElementChild);
		}

		return;
	}


	switch (e.key) {
		case ' ': {
			e.preventDefault();
			const checkboxes = document.activeElement.getElementsByClassName('checkbox');
			if (checkboxes && checkboxes.length) {
				const checkbox = checkboxes[0];
				checkbox.checked = !checkbox.checked;
			}
			break;
		}
		case '\r': {
			const inputs = document.activeElement.getElementsByTagName('input');
			if (inputs && inputs.length) {
				document.activeElement = inputs[0];
				return;
			}

			const submenus = document.activeElement.getElementsByClassName('submenu');
			if (submenus && submenus.length) {
				setMenu(submenus[0].id);
			}
			break;
		}

		case 'ArrowRight': {
			const button = document.activeElement.getElementsByClassName('button');
			if (button.length && button[0].onclick) {
				button[0].click();
			}
			break;
		}

		case 'ArrowDown':
			e.preventDefault();
			setActive(document.activeElement.nextElementSibling);
			break;

		case 'ArrowUp':
			e.preventDefault();
			setActive(document.activeElement.previousElementSibling);
			break;
	}
});

function createRow(item) {
	const row = document.createElement('label');
	row.id = item.id;
	row.className = 'row';
	if (item.type === 'bool') {
		const checkbox = document.createElement('div');
		checkbox.class`<input type="checkbox" class="hidden" id="${id}" ${e.config.evaluate(this.ctx) ? 'checked' : ''}><span class="checkmark"><img src="${this.mediaPath('check.svg')}"/></span>`
	}

};

function setMenu(id, up=false) {
	vscode.postMessage({
		cmd: 'openMenu',
		id,
		up,
	});
}

var stack = [];

function submenu(self, sub) {
	const button = document.getElementById(self).getElementsByClassName('button');
	if (button[0].classList.contains('disabled')) {
		return;
	}

	stack.push(self);
	setMenu(sub);
}

// Handle the message inside the webview
window.addEventListener('message', event => {
	const message = event.data;
	switch (message.cmd) {
		case 'setHelp':
			help.textContent = message.data;
			if (message.data.length) {
				help.className = "help";
			} else {
				help.className = "hidden";
			}
			break;
		case 'setMenu': {
			const content = document.getElementById('menuconfig-content');
			const title = document.getElementById('menu-title');
			const up = document.getElementById('up');

			content.innerHTML = message.content;
			if (message.goingUp && stack.length) {
				const focused = document.getElementById(stack.pop());
				if (focused && focused.focus)
					focused.focus();
			}

			if (message.up && message.up !== 'root(ROOT)') {
				up.classList = ['button'];
				up.onclick = function() {
					setMenu(message.up, true);
				};
			} else {
				up.classList = 'button disabled';
				up.onclick = null;
			}

			title.textContent = message.name;
			break;
		}
	}
});

