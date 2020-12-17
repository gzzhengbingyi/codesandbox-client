import React, { createContext, useContext, PureComponent } from 'react';
import { Manager, generatePackageJSON } from 'smooshpack';
import { listen } from 'codesandbox-api';

import {
  IFiles,
  IManagerState,
  ISandpackContext,
  IModuleError,
  ManagerStatus,
  IFile,
  SandboxEnvironment,
} from '../types';

const SandpackContext = createContext<ISandpackContext | null>(null);

export interface State {
  files: IFiles;
  browserPath: string;
  openedPath: string;
  iframe: HTMLIFrameElement | null;
  managerState: IManagerState | undefined;
  errors: Array<IModuleError>;
  status: ManagerStatus;
}

export interface Props {
  showOpenInCodeSandbox?: boolean;
  className?: string;
  style?: Object;
  files: IFiles;
  initialPath?: string;
  entry?: string;
  openedPath?: string;
  dependencies?: Record<string, string>;
  width?: number | string;
  height?: number | string;
  bundlerURL?: string;
  skipEval?: boolean;
  template?: SandboxEnvironment;

  onFileChange?: (files: IFiles, sandpack: ISandpackContext) => void;
  fileResolver?: {
    isFile: (path: string) => Promise<boolean>;
    readFile: (path: string) => Promise<string>;
  };
}

// TODO: Why is iframe on both class and state
// TODO: Provider API (props)
// TODO: Get rid of the codesandbox-api dependency
class SandpackProvider extends PureComponent<Props, State> {
  static defaultProps = {
    skipEval: false,
  };

  manager?: Manager;
  iframe?: HTMLIFrameElement;
  listener: Function;

  constructor(props: Props) {
    super(props);

    this.state = {
      files: this.createMissingPackageJSON(
        props.files,
        props.dependencies,
        props.entry
      ),
      browserPath: props.initialPath || '/',
      openedPath: props.openedPath || props.entry || '/index.js',
      iframe: null,
      managerState: undefined,
      errors: [],
      status: 'initializing',
    };

    this.listener = listen(this.handleMessage);
  }

  handleMessage = (m: any) => {
    if (m.type === 'state') {
      this.setState({ managerState: m.state });
    } else if (m.type === 'start') {
      this.setState({ errors: [] });
    } else if (m.type === 'status') {
      this.setState({ status: m.status });
    } else if (m.type === 'action' && m.action === 'show-error') {
      const { title, path, message, line, column } = m;
      this.setState(state => ({
        errors: [...state.errors, { title, path, message, line, column }],
      }));
    }
  };

  createMissingPackageJSON(
    files: IFiles,
    dependencies?: {
      [depName: string]: string;
    },
    entry?: string
  ) {
    const newFiles = { ...files };

    if (!newFiles['/package.json']) {
      if (!dependencies) {
        throw new Error(
          'No dependencies specified, please specify either a package.json or dependencies.'
        );
      }

      if (!entry) {
        throw new Error(
          "No entry specified, please specify either a package.json with 'main' field or dependencies."
        );
      }

      newFiles['/package.json'] = {
        code: JSON.stringify(
          {
            name: 'run',
            main: entry,
            dependencies,
          },
          null,
          2
        ),
      };
    }

    return newFiles;
  }

  getOptions = () => ({
    bundlerURL: this.props.bundlerURL,
    fileResolver: this.props.fileResolver,
    skipEval: this.props.skipEval,
  });

  setupFrame = (el: HTMLIFrameElement) => {
    if (el) {
      this.manager = new Manager(
        el,
        {
          files: generatePackageJSON(
            this.props.files,
            this.props.dependencies,
            this.props.entry
          ),
          template: this.props.template,
          showOpenInCodeSandbox: this.props.showOpenInCodeSandbox,
        },
        this.getOptions()
      );

      this.iframe = el;

      this.setState({ iframe: el });
    }
  };

  updateCurrentFile = (file: IFile) => {
    if (file.code !== this.state.files[this.state.openedPath]?.code) {
      this.updateFiles({
        ...this.state.files,
        [this.state.openedPath]: file,
      });
    }
  };

  updateFiles = (files: IFiles) => {
    this.setState({ files });

    if (this.props.onFileChange) {
      this.props.onFileChange(files, this._getSandpackState());
    }

    if (this.manager) {
      this.manager.updatePreview({
        showOpenInCodeSandbox: this.props.showOpenInCodeSandbox,
        files,
        template: this.props.template,
      });
    }
  };

  componentDidUpdate(props: Props) {
    if (
      props.files !== this.props.files ||
      props.dependencies !== this.props.dependencies ||
      props.entry !== this.props.entry ||
      props.template !== this.props.template
    ) {
      const newFiles = this.createMissingPackageJSON(
        this.props.files,
        this.props.dependencies,
        this.props.entry
      );

      this.updateFiles(newFiles);
    }

    if (this.manager && this.props.skipEval !== props.skipEval) {
      this.manager.updateOptions(this.getOptions());
    }
  }

  componentWillUnmount() {
    this.listener();
  }

  openFile = (path: string) => {
    this.setState({ openedPath: path });
  };

  /**
   * Get information about the transpilers that are currently registered to the
   * preset
   */
  getManagerTranspilerContext = (): Promise<{ [transpiler: string]: Object }> =>
    new Promise(resolve => {
      const listener = listen((message: any) => {
        if (message.type === 'transpiler-context') {
          resolve(message.data);

          listener();
        }
      });

      if (this.manager) {
        this.manager.dispatch({ type: 'get-transpiler-context' });
      }
    });

  _getSandpackState = (): ISandpackContext => {
    const {
      iframe,
      files,
      browserPath,
      openedPath,
      managerState,
      errors,
      status,
    } = this.state;

    return {
      files,
      openedPath,
      browserPath,
      errors,
      managerState,
      managerStatus: status,
      openFile: this.openFile,
      getManagerTranspilerContext: this.getManagerTranspilerContext,
      browserFrame: iframe,
      updateFiles: this.updateFiles,
      updateCurrentFile: this.updateCurrentFile,
      bundlerURL: this.manager ? this.manager.bundlerURL : undefined,
    };
  };

  render() {
    const { children, className, style } = this.props;

    return (
      <SandpackContext.Provider value={this._getSandpackState()}>
        <div style={style} className={`${className || ''} sandpack`}>
          {/* We create a hidden iframe, the bundler will live in this.
            We expose this iframe to the Consumer, so other components can show the full
            iframe for preview. An implementation can be found in `Preview` component. */}
          <iframe
            ref={this.setupFrame}
            title="sandpack-sandbox"
            style={{
              width: 0,
              height: 0,
              border: 0,
              outline: 0,
              position: 'absolute',
              visibility: 'hidden',
            }}
            allow="accelerometer; ambient-light-sensor; camera; encrypted-media; geolocation; gyroscope; hid; microphone; midi; payment; usb; vr; xr-spatial-tracking"
            sandbox="allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts"
            src={this.props.bundlerURL}
          />
          {children}
        </div>
      </SandpackContext.Provider>
    );
  }
}

const SandpackConsumer = SandpackContext.Consumer;

function getDisplayName(
  WrappedComponent: React.ComponentClass<any> | React.FC<any>
) {
  return WrappedComponent.displayName || WrappedComponent.name || 'Component';
}

function useSandpack() {
  return useContext(SandpackContext) as ISandpackContext;
}

function withSandpack(Component: React.ComponentClass<any> | React.FC<any>) {
  const WrappedComponent = (props: any) => (
    <SandpackConsumer>
      {sandpack => <Component {...props} sandpack={sandpack} />}
    </SandpackConsumer>
  );

  WrappedComponent.displayName = `WithSandpack(${getDisplayName(Component)})`;

  return WrappedComponent;
}

export {
  SandpackProvider,
  SandpackConsumer,
  SandpackContext,
  withSandpack,
  useSandpack,
};
