// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract PUSD {
    string public constant name = "Private USD";
    string public constant symbol = "PUSD";
    string public constant version = "1";
    uint8 public constant decimals = 18;

    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        keccak256(
            "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        keccak256(
            "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    bytes32 public immutable DOMAIN_SEPARATOR;

    bool public paused;
    uint256 public totalSupply;

    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;
    mapping(bytes32 => mapping(address => bool)) private _roles;
    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    modifier onlyRole(bytes32 role) {
        require(hasRole(role, msg.sender), "MISSING_ROLE");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "PAUSED");
        _;
    }

    constructor(address admin, address operator) {
        require(admin != address(0), "ADMIN_REQUIRED");
        require(operator != address(0), "OPERATOR_REQUIRED");

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, operator);
        _grantRole(BURNER_ROLE, operator);
        _grantRole(PAUSER_ROLE, operator);

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                block.chainid,
                address(this)
            )
        );
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowances[owner][spender];
    }

    function hasRole(bytes32 role, address account) public view returns (bool) {
        return _roles[role][account];
    }

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    function grantRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(role, account);
    }

    function revokeRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_roles[role][account]) {
            _roles[role][account] = false;
            emit RoleRevoked(role, account, msg.sender);
        }
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function approve(address spender, uint256 value) external whenNotPaused returns (bool) {
        _allowances[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external whenNotPaused returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external whenNotPaused returns (bool) {
        uint256 currentAllowance = _allowances[from][msg.sender];
        require(currentAllowance >= value, "ALLOWANCE_EXCEEDED");

        unchecked {
            _allowances[from][msg.sender] = currentAllowance - value;
        }

        emit Approval(from, msg.sender, _allowances[from][msg.sender]);
        _transfer(from, to, value);
        return true;
    }

    function mint(address to, uint256 value) external onlyRole(MINTER_ROLE) whenNotPaused {
        require(to != address(0), "ZERO_ADDRESS");
        totalSupply += value;
        _balances[to] += value;
        emit Transfer(address(0), to, value);
    }

    function burn(address from, uint256 value) external onlyRole(BURNER_ROLE) whenNotPaused {
        _burn(from, value);
    }

    function burnFrom(address from, uint256 value) external onlyRole(BURNER_ROLE) whenNotPaused {
        uint256 currentAllowance = _allowances[from][msg.sender];
        require(currentAllowance >= value, "ALLOWANCE_EXCEEDED");

        unchecked {
            _allowances[from][msg.sender] = currentAllowance - value;
        }

        emit Approval(from, msg.sender, _allowances[from][msg.sender]);
        _burn(from, value);
    }

    function _burn(address from, uint256 value) internal {
        require(from != address(0), "ZERO_ADDRESS");
        uint256 balance = _balances[from];
        require(balance >= value, "BALANCE_EXCEEDED");

        unchecked {
            _balances[from] = balance - value;
            totalSupply -= value;
        }

        emit Transfer(from, address(0), value);
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external whenNotPaused {
        _useAuthorization(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
            from,
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)),
            validAfter,
            validBefore,
            nonce,
            v,
            r,
            s
        );

        _transfer(from, to, value);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external whenNotPaused {
        require(to == msg.sender, "CALLER_MUST_BE_PAYEE");

        _useAuthorization(
            RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
            from,
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)),
            validAfter,
            validBefore,
            nonce,
            v,
            r,
            s
        );

        _transfer(from, to, value);
    }

    function cancelAuthorization(
        address authorizer,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(!_authorizationStates[authorizer][nonce], "AUTH_ALREADY_USED");

        bytes32 structHash = keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce));
        address signer = _recoverSigner(structHash, v, r, s);
        require(signer == authorizer, "INVALID_SIGNATURE");

        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _grantRole(bytes32 role, address account) internal {
        if (!_roles[role][account]) {
            _roles[role][account] = true;
            emit RoleGranted(role, account, msg.sender);
        }
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(to != address(0), "ZERO_ADDRESS");

        uint256 fromBalance = _balances[from];
        require(fromBalance >= value, "BALANCE_EXCEEDED");

        unchecked {
            _balances[from] = fromBalance - value;
        }
        _balances[to] += value;

        emit Transfer(from, to, value);
    }

    function _useAuthorization(
        bytes32,
        address authorizer,
        bytes32 structHash,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        require(block.timestamp >= validAfter, "AUTH_NOT_YET_VALID");
        require(block.timestamp <= validBefore, "AUTH_EXPIRED");
        require(!_authorizationStates[authorizer][nonce], "AUTH_ALREADY_USED");

        address signer = _recoverSigner(structHash, v, r, s);
        require(signer == authorizer, "INVALID_SIGNATURE");

        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationUsed(authorizer, nonce);
    }

    function _recoverSigner(
        bytes32 structHash,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal view returns (address) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        return ecrecover(digest, v, r, s);
    }
}
